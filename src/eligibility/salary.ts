import type { StructuredPay } from "../discovery/types.js";

export type PayBasis = "base" | "ote" | "total" | "unknown";

export interface PayRange {
  min: number | null;
  max: number | null;
  currency: string;
  interval: "year" | "hour" | "month" | "unknown";
  basis: PayBasis;
  /** Annualized USD values for comparison (hourly x hours_per_year, monthly x 12). */
  annualMin: number | null;
  annualMax: number | null;
  source: string;
  evidence?: string;
}

export type CompStatus = "BASE_KNOWN" | "NON_BASE_ONLY" | "UNKNOWN_COMP";

export interface CompResult {
  status: CompStatus;
  ranges: PayRange[];
  /** Highest annual base max across USD base ranges (null if none). */
  baseMax: number | null;
  baseMin: number | null;
  verdict: "pass" | "fail" | "unknown";
  reason: string;
}

const SALES_TITLE = /\b(account executive|sales|business development|\bbdr\b|\bsdr\b|account manager|partnerships?)\b/i;

function annualize(v: number | null, interval: PayRange["interval"], hoursPerYear: number): number | null {
  if (v == null) return null;
  if (interval === "hour") return Math.round(v * hoursPerYear);
  if (interval === "month") return Math.round(v * 12);
  return v;
}

function structuredBasis(p: StructuredPay, title: string): PayBasis {
  const label = p.label ?? "";
  if (/\bOTE\b|on[- ]target|commission/i.test(label)) {
    // Greenhouse boards often carry a generic blurb ("For sales roles, the range is OTE").
    // That sentence does not make an engineering role's range OTE.
    if (/for sales roles/i.test(label) && !SALES_TITLE.test(title)) return "base";
    return "ote";
  }
  if (/total (target )?comp/i.test(label)) return "total";
  return "base";
}

// ---------- text parsing ----------

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?([kK])?`;
const CUR = String.raw`(?:US\$|\$|USD\s?)`;
const RANGE_RE = new RegExp(
  String.raw`${CUR}\s?${NUM}\s*(?:-|–|—|to|and)\s*(?:${CUR})?\s?${NUM}(\s?USD)?`,
  "g",
);
const RANGE_NO_SYMBOL_RE = new RegExp(String.raw`\b${NUM}\s*(?:-|–|—|to)\s*${NUM}\s?(USD)\b`, "g");
const SINGLE_RE = new RegExp(String.raw`${CUR}\s?${NUM}(\+)?`, "g");

function toNumber(n: string | undefined, k: string | undefined): number | null {
  if (!n) return null;
  const v = parseFloat(n.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  return k ? v * 1000 : v;
}

function contextOf(text: string, idx: number, len: number): { before: string; after: string; snippet: string } {
  const before = text.slice(Math.max(0, idx - 160), idx);
  const after = text.slice(idx + len, idx + len + 60);
  return { before, after, snippet: text.slice(Math.max(0, idx - 60), idx + len + 30).replace(/\s+/g, " ").trim() };
}

function inferInterval(after: string, before: string, max: number): PayRange["interval"] {
  const ctx = `${before.slice(-40)} ${after}`;
  if (/(per|an|\/)\s?(hour|hr)\b|hourly/i.test(ctx)) return "hour";
  if (/(per|a|\/)\s?month|monthly/i.test(ctx)) return "month";
  if (/(per|a|\/)\s?(year|yr|annum)|annual|yearly|salary/i.test(ctx)) return max < 1000 ? "hour" : "year";
  if (max >= 20000) return "year";
  if (max >= 15 && max <= 500) return "hour";
  return "unknown";
}

function inferTextBasis(before: string, after: string): PayBasis {
  // A qualifier attached right after the figure wins ("$200K OTE", "$250K total comp").
  const tail = after.slice(0, 30);
  if (/^\s*(?:\/\s?\w+\s*)?\(?\s*(?:OTE|on[- ]target)/i.test(tail)) return "ote";
  if (/^\s*(?:\/\s?\w+\s*)?\(?\s*(?:total (?:target )?comp|TC\b)/i.test(tail)) return "total";
  // Otherwise the nearest label before the figure decides. Text after the figure such as
  // "Total compensation may also include equity" does not change a stated salary range.
  const near = before.slice(-120);
  const last = (re: RegExp) => {
    let idx = -1;
    for (const m of near.matchAll(re)) idx = m.index!;
    return idx;
  };
  const candidates: [PayBasis, number][] = [
    ["ote", last(/\bOTE\b|on[- ]target earnings/gi)],
    ["total", last(/total (?:target )?(?:cash )?comp(?:ensation)?|\bTC\b|including (?:equity|bonus|stock)/gi)],
    ["base", last(/base|salary|pay (?:range|scale|transparency)|(?<!total )compensation range|hourly rate|annual/gi)],
  ];
  const best = candidates.filter(([, i]) => i >= 0).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : "unknown";
}

function plausible(min: number | null, max: number | null, interval: PayRange["interval"]): boolean {
  const vals = [min, max].filter((v): v is number => v != null);
  if (!vals.length) return false;
  if (interval === "hour") return vals.every((v) => v >= 15 && v <= 500);
  if (interval === "year") return vals.every((v) => v >= 30000 && v <= 1500000);
  if (interval === "month") return vals.every((v) => v >= 2500 && v <= 125000);
  return false;
}

/** Extracts pay ranges stated in posting text. Never invents values. */
export function parseTextPay(text: string, hoursPerYear = 2080): PayRange[] {
  const out: PayRange[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

  const push = (m: RegExpExecArray, minS: string | undefined, minK: string | undefined, maxS: string | undefined, maxK: string | undefined, currency = "USD") => {
    // Skip funding amounts like "$100M" or "$2 billion".
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 10);
    if (/^\s?(m\b|mm\b|b\b|bn\b|million|billion)/i.test(tail)) return;
    let min = toNumber(minS, minK);
    let max = toNumber(maxS, maxK);
    // "$150 - $200K": the K applies to both ends.
    if (min != null && max != null && !minK && maxK && min < 1000) min *= 1000;
    if (min != null && max != null && min > max) [min, max] = [max, min];
    const { before, after, snippet } = contextOf(text, m.index, m[0].length);
    const interval = inferInterval(after, before, max ?? min ?? 0);
    if (!plausible(min, max, interval)) return;
    taken.push([m.index, m.index + m[0].length]);
    out.push({
      min, max, currency, interval,
      basis: inferTextBasis(before, after),
      annualMin: annualize(min, interval, hoursPerYear),
      annualMax: annualize(max, interval, hoursPerYear),
      source: "description_text",
      evidence: snippet,
    });
  };

  for (const m of text.matchAll(RANGE_RE)) push(m as RegExpExecArray, m[1], m[2], m[3], m[4]);
  for (const m of text.matchAll(RANGE_NO_SYMBOL_RE)) {
    if (!overlaps(m.index!, m.index! + m[0].length)) push(m as RegExpExecArray, m[1], m[2], m[3], m[4]);
  }
  for (const m of text.matchAll(SINGLE_RE)) {
    const s = m.index!;
    if (overlaps(s, s + m[0].length)) continue;
    const before = text.slice(Math.max(0, s - 80), s);
    // Single figures only count when introduced as pay.
    if (!/(salary|base|pay|compensation|rate)[^.\n]{0,60}$/i.test(before)) continue;
    const isUpTo = /up to\s*$/i.test(before);
    push(m as RegExpExecArray, isUpTo ? undefined : m[1], isUpTo ? undefined : m[2], m[1], m[2]);
  }
  return out;
}

// ---------- evaluation ----------

export function evaluateComp(
  input: { title: string; structuredPay: StructuredPay[]; descriptionText: string },
  cfg: { min_base_usd: number; hours_per_year: number },
): CompResult {
  let ranges: PayRange[] = input.structuredPay
    .filter((p) => p.min != null || p.max != null)
    .map((p) => ({
      min: p.min, max: p.max, currency: p.currency.toUpperCase(), interval: p.interval,
      basis: structuredBasis(p, input.title),
      annualMin: annualize(p.min, p.interval, cfg.hours_per_year),
      annualMax: annualize(p.max, p.interval, cfg.hours_per_year),
      source: p.source,
      evidence: p.label,
    }));
  if (!ranges.length) ranges = parseTextPay(input.descriptionText, cfg.hours_per_year);

  const usd = ranges.filter((r) => r.currency === "USD");
  const base = usd.filter((r) => r.basis === "base");
  const baseMax = maxOf(base.map((r) => r.annualMax ?? r.annualMin));
  const baseMin = minOf(base.map((r) => r.annualMin ?? r.annualMax));

  if (!usd.length) {
    return { status: "UNKNOWN_COMP", ranges, baseMax: null, baseMin: null, verdict: "unknown", reason: ranges.length ? "pay stated only in non-USD currency" : "compensation not advertised" };
  }
  if (base.length) {
    if (baseMax != null && baseMax >= cfg.min_base_usd) {
      return { status: "BASE_KNOWN", ranges, baseMax, baseMin, verdict: "pass", reason: `base up to $${fmt(baseMax)}` };
    }
    return { status: "BASE_KNOWN", ranges, baseMax, baseMin, verdict: "fail", reason: `base max $${fmt(baseMax)} below minimum $${fmt(cfg.min_base_usd)}` };
  }
  // Only OTE / total / unclear figures. Base is at most these, so a low ceiling still disqualifies.
  const anyMax = maxOf(usd.map((r) => r.annualMax ?? r.annualMin));
  if (anyMax != null && anyMax < cfg.min_base_usd) {
    return { status: "NON_BASE_ONLY", ranges, baseMax: null, baseMin: null, verdict: "fail", reason: `stated pay (not base) tops out at $${fmt(anyMax)}, below minimum base` };
  }
  return { status: "NON_BASE_ONLY", ranges, baseMax: null, baseMin: null, verdict: "unknown", reason: "only OTE/total/unlabeled pay stated; base unknown" };
}

const maxOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.max(...v) : null;
};
const minOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.min(...v) : null;
};
const fmt = (n: number | null) => (n == null ? "?" : n.toLocaleString("en-US"));
