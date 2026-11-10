import { writeFileSync } from "node:fs";
import YAML from "yaml";
import type { DB } from "../db/index.js";

/**
 * Builds the hand-labeled evaluation set (spec section 14): 20 real postings, stratified so
 * every rule is exercised. The user fills in `your_label` (ELIGIBLE or INELIGIBLE).
 */
export function exportLabelSet(db: DB, outYaml: string, outJson: string, size = 20): number {
  const buckets: { name: string; n: number; where: string }[] = [
    { name: "qualified, remote", n: 4, where: "state = 'QUALIFIED' AND json_extract(location_json,'$.classification') LIKE 'REMOTE%'" },
    { name: "qualified, DC office", n: 3, where: "state = 'QUALIFIED' AND json_extract(location_json,'$.classification') IN ('HYBRID_DC','ONSITE_DC','OFFICE_DC_UNSPECIFIED')" },
    { name: "AI policy hold", n: 2, where: "state = 'NEEDS_ATTENTION'" },
    { name: "rejected: location", n: 4, where: "state = 'INELIGIBLE' AND json_extract(eligibility_json,'$.role.ok') = 1 AND json_extract(eligibility_json,'$.location.acceptable') = 0" },
    { name: "rejected: pay", n: 2, where: "state = 'INELIGIBLE' AND json_extract(comp_json,'$.verdict') = 'fail' AND json_extract(eligibility_json,'$.role.ok') = 1" },
    { name: "rejected: clearance", n: 2, where: "state = 'INELIGIBLE' AND json_extract(eligibility_json,'$.clearance.status') = 'REQUIRED' AND json_extract(eligibility_json,'$.location.acceptable') != 0" },
    { name: "unknown pay or unclear remote", n: 2, where: "state = 'QUALIFIED' AND (flags_json LIKE '%UNKNOWN_COMP%' OR flags_json LIKE '%REMOTE_POLICY_UNCLEAR%' OR flags_json LIKE '%REMOTE_COUNTRY_UNSPECIFIED%')" },
    { name: "rejected: title", n: 1, where: "state = 'INELIGIBLE' AND json_extract(eligibility_json,'$.role.ok') = 0 AND title LIKE '%engineer%'" },
  ];
  const seen = new Set<number>();
  const items: Record<string, unknown>[] = [];
  const full: Record<string, unknown>[] = [];
  for (const b of buckets) {
    const rows = db
      .prepare(`SELECT id, company_name, title, location_raw, url, state, eligibility_json, normalized_json FROM postings WHERE closed_at IS NULL AND ${b.where} ORDER BY random() LIMIT ?`)
      .all(b.n * 3) as { id: number; company_name: string; title: string; location_raw: string; url: string; state: string; eligibility_json: string; normalized_json: string }[];
    let taken = 0;
    for (const r of rows) {
      if (taken >= b.n || seen.has(r.id) || items.length >= size) break;
      seen.add(r.id);
      taken++;
      const e = JSON.parse(r.eligibility_json);
      items.push({
        id: r.id,
        company: r.company_name,
        title: r.title,
        location: r.location_raw,
        url: r.url,
        system_says: e.verdict === "ELIGIBLE" ? (r.state === "NEEDS_ATTENTION" ? "ELIGIBLE (held: AI policy)" : "ELIGIBLE") : "INELIGIBLE",
        why: e.verdict === "ELIGIBLE" ? `${e.location.classification}; pay ${e.comp.status}${e.comp.baseMax ? ` up to $${e.comp.baseMax}` : ""}` : e.reasons.join("; ").slice(0, 200),
        flags: (e.flags as { code: string }[]).map((f) => f.code).join(", ") || undefined,
        your_label: null,
        your_note: null,
      });
      full.push({ id: r.id, bucket: b.name, posting: JSON.parse(r.normalized_json), system: { verdict: e.verdict, reasons: e.reasons, flags: e.flags }, user_label: null });
    }
  }
  const header =
    "# Hand-label pass (about 10 minutes). For each posting set your_label to ELIGIBLE or INELIGIBLE\n" +
    "# based only on your hard criteria (pay floor, location, employment type, clearance), not on interest.\n" +
    "# Optional: your_note for anything the system got wrong. Open the url if the summary is not enough.\n";
  writeFileSync(outYaml, header + YAML.stringify({ postings: items }, { lineWidth: 0 }));
  writeFileSync(outJson, JSON.stringify(full, null, 1));
  return items.length;
}
