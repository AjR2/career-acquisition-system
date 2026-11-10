import type { DB } from "../db/index.js";
import type { ResumeDraft } from "../drafting/schemas.js";
import { sha256 } from "../pipeline/dedupe.js";
import type { Claim } from "./claims.js";

/**
 * Approved wording: the exact text of resume bullets the user approved, keyed by the set of claims
 * each bullet cites. Later drafts must reuse it verbatim, so the user reviews a sentence once and
 * every application says it the same way. An entry goes stale (and is ignored) when any of its
 * claims changes in approved-claims.yaml, so editing a claim reopens its wording for review.
 */
export interface ApprovedWording {
  key: string;
  claimIds: string[];
  text: string;
}

export const wordingKey = (ids: string[]): string => [...new Set(ids)].sort().join("+");

/** Resume voice rule shared with the drafting validator: fragments, no pronouns. */
export const PRONOUN = /\b(I|me|my|mine|we|our|us)\b/;

/** Fingerprint of the cited claims' current text; null if any claim no longer exists. */
function claimsFingerprint(ids: string[], claims: Claim[]): string | null {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const parts: string[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const c = byId.get(id);
    if (!c) return null;
    parts.push(`${id}\u0000${c.claim_text}\u0000${c.dates}`);
  }
  return sha256(parts.join("\u0001"));
}

export const normalizeWording = (s: string): string => s.trim().replace(/\s+/g, " ").replace(/[.;]+$/, "");

/** Saves every experience and project bullet of an approved draft. Latest approval wins per key. */
export function saveApprovedWording(db: DB, draft: ResumeDraft, claims: Claim[], postingId: number): number {
  const upsert = db.prepare(
    `INSERT INTO approved_wording (key, text, claim_ids_json, claims_fp, source_posting_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET text = excluded.text, claim_ids_json = excluded.claim_ids_json, claims_fp = excluded.claims_fp,
       source_posting_id = excluded.source_posting_id, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  let saved = 0;
  for (const e of [...draft.experience, ...(draft.projects ?? [])]) {
    for (const b of e.bullets) {
      if (b.kind !== "fact" || !b.claim_ids.length || PRONOUN.test(b.text)) continue; // never lock in text that breaks a current rule
      const fp = claimsFingerprint(b.claim_ids, claims);
      if (!fp) continue;
      upsert.run(wordingKey(b.claim_ids), b.text.trim(), JSON.stringify([...new Set(b.claim_ids)].sort()), fp, postingId);
      saved++;
    }
  }
  return saved;
}

/** Current approved wording, skipping entries whose claims changed since approval. */
export function loadApprovedWording(db: DB, claims: Claim[]): Map<string, ApprovedWording> {
  const rows = db.prepare("SELECT key, text, claim_ids_json, claims_fp FROM approved_wording").all() as { key: string; text: string; claim_ids_json: string; claims_fp: string }[];
  const out = new Map<string, ApprovedWording>();
  for (const r of rows) {
    const ids = JSON.parse(r.claim_ids_json) as string[];
    if (claimsFingerprint(ids, claims) === r.claims_fp) out.set(r.key, { key: r.key, claimIds: ids, text: r.text });
  }
  return out;
}

/** True when a bullet's text matches the approved wording for its claim set. */
export function isApprovedWording(text: string, claimIds: string[], approved: Map<string, ApprovedWording>): boolean {
  const a = approved.get(wordingKey(claimIds));
  return !!a && normalizeWording(a.text) === normalizeWording(text);
}
