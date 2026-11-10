import type { ApplicationQuestion } from "../discovery/types.js";

// ---------- employment type ----------

export type EmploymentType = "FULL_TIME" | "CONTRACT_TO_HIRE" | "CONTRACT" | "PART_TIME" | "INTERNSHIP" | "UNKNOWN";

export function classifyEmployment(input: { title: string; employmentTypeRaw: string | null; descriptionText: string }): { type: EmploymentType; evidence: string | null } {
  const raw = (input.employmentTypeRaw ?? "").toLowerCase().replace(/[\s_-]/g, "");
  const title = input.title;
  const text = input.descriptionText;
  const c2h = /contract[- ]to[- ](hire|perm)|temp[- ]to[- ](hire|perm)|\bc2h\b|right[- ]to[- ]hire/i;
  if (c2h.test(title) || c2h.test(text)) return { type: "CONTRACT_TO_HIRE", evidence: (title.match(c2h) ?? text.match(c2h))![0] };
  if (/\bintern(ship)?\b|co-?op\b/i.test(title) || raw === "intern" || raw === "internship") return { type: "INTERNSHIP", evidence: input.employmentTypeRaw ?? title };
  if (/\b(contract|contractor|freelance|temporary|temp)\b/i.test(title)) return { type: "CONTRACT", evidence: title };
  if (raw === "contract" || raw === "temporary" || raw === "fixedterm" || raw === "contractor") return { type: "CONTRACT", evidence: input.employmentTypeRaw };
  if (/\b(per[- ]diem|prn)\b/i.test(title) || raw === "perdiem" || raw === "prn") return { type: "PART_TIME", evidence: "per diem / PRN" };
  if (raw === "parttime") return { type: "PART_TIME", evidence: input.employmentTypeRaw };
  if (raw === "fulltime" || raw === "permanent") return { type: "FULL_TIME", evidence: input.employmentTypeRaw };
  const contractText = text.match(/this is an? (\d+[- ]month |short[- ]term |fixed[- ]term |temporary )?(contract|contractor|freelance) (role|position|engagement)/i);
  if (contractText) return { type: "CONTRACT", evidence: contractText[0] };
  if (/\bpart[- ]time (role|position)\b/i.test(text)) return { type: "PART_TIME", evidence: "part-time role" };
  if (/\bfull[- ]time\b/i.test(text)) return { type: "FULL_TIME", evidence: "description says full-time" };
  return { type: "UNKNOWN", evidence: null };
}

// ---------- security clearance ----------

export type ClearanceStatus = "REQUIRED" | "SPONSORSHIP_AVAILABLE" | "PREFERRED" | "NONE_MENTIONED";

export interface ClearanceResult {
  status: ClearanceStatus;
  evidence: string | null;
  citizenshipRequired: string | null;
}

const LEVEL = String.raw`(?:ts\s?\/\s?sci|top[- ]secret|secret|public trust|dod|government|security|federal)`;
const REQUIRED_PATTERNS = [
  new RegExp(String.raw`\b(?:active|current)\s+(?:${LEVEL}[\s\/a-z-]{0,25})?clearance`, "i"),
  new RegExp(String.raw`\b(?:must|required to|need to|will need to)\s+(?:currently\s+)?(?:possess|hold|have|maintain)\s+(?:an?\s+)?(?:active\s+)?${LEVEL}?[\s\/a-z-]{0,20}clearance`, "i"),
  new RegExp(String.raw`\b${LEVEL}[\s\/a-z-]{0,25}clearance\s+(?:is\s+)?required`, "i"),
  new RegExp(String.raw`\bclearance\s+(?:is\s+)?(?:required|mandatory)`, "i"),
  new RegExp(String.raw`\brequires?\s+(?:an?\s+)?(?:active\s+)?${LEVEL}[\s\/a-z-]{0,20}clearance`, "i"),
  /\b(?:full[- ]scope|ci)\s+poly(?:graph)?\b/i,
];
const SPONSOR_PATTERNS = [
  /\b(?:ability|able|eligib\w*|willing(?:ness)?|capable)\s+(?:of\s+|to\s+)?(?:obtain|obtaining|acquire|acquiring|get|getting|be granted)(?:\s+and\s+(?:maintain|hold))?\s+(?:an?\s+)?(?:[\w\/-]+\s+){0,4}clearance/i,
  /\bclearance\s+sponsorship\b/i,
  /\b(?:we|will|can)\s+sponsor\s+(?:an?\s+|your\s+|the\s+)?(?:[\w\/-]+\s+){0,2}clearance/i,
  /\bclearable\b/i,
];
const PREFERRED_PATTERNS = [
  /\bclearance\s+(?:is\s+)?(?:a\s+plus|a\s+bonus|preferred|nice[- ]to[- ]have|desired|desirable|beneficial)/i,
  /\b(?:preferred|bonus|nice[- ]to[- ]have|plus)\b[^.\n]{0,60}\bclearance\b/i,
];
const CITIZENSHIP = /\b(?:must be an? u\.?s\.? citizen|u\.?s\.? citizenship (?:is )?required|requires? u\.?s\.? citizenship|only u\.?s\.? citizens|u\.?s\.? persons? (?:status )?(?:is )?required|itar)\b[^.\n]{0,80}/i;

function snippet(text: string, re: RegExp): string | null {
  const m = text.match(re);
  if (!m || m.index == null) return null;
  return text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50).replace(/\s+/g, " ").trim();
}

/**
 * Background-check language is deliberately NOT clearance language.
 * A pending background check never satisfies a clearance requirement.
 */
export function classifyClearance(text: string): ClearanceResult {
  const citizenshipRequired = snippet(text, CITIZENSHIP);
  const sponsor = SPONSOR_PATTERNS.map((p) => snippet(text, p)).find(Boolean) ?? null;
  const required = REQUIRED_PATTERNS.map((p) => snippet(text, p)).find(Boolean) ?? null;
  const preferred = PREFERRED_PATTERNS.map((p) => snippet(text, p)).find(Boolean) ?? null;
  // "Active TS required, with eligibility to obtain SCI/poly" is an upgrade path, not sponsorship.
  const upgradeOnly = required && /\b(active|current)\b/i.test(required) && sponsor && /\bsci\b|poly|upgrade|higher level/i.test(sponsor);
  if (sponsor && !upgradeOnly) return { status: "SPONSORSHIP_AVAILABLE", evidence: sponsor, citizenshipRequired };
  if (preferred && (!required || /preferred|plus|bonus|nice/i.test(required))) return { status: "PREFERRED", evidence: preferred, citizenshipRequired };
  if (required) return { status: "REQUIRED", evidence: required, citizenshipRequired };
  return { status: "NONE_MENTIONED", evidence: null, citizenshipRequired };
}

// ---------- employer AI-use policy ----------

export interface AiPolicyResult {
  detected: boolean;
  text: string | null;
}

const AI_TERM = String.raw`(?:\bAI\b|artificial intelligence|generative|gen ?AI|chat ?gpt|\bLLMs?\b|large language model|claude)`;
// Questions about the employer's AI policy or the candidate's AI use in this application,
// not questions about AI experience ("describe a project using LLMs").
const AI_QUESTION = new RegExp(
  String.raw`${AI_TERM}\s+(?:usage\s+|use\s+)?policy|${AI_TERM}[^?]{0,60}(?:in|for|on|with)\s+(?:your|this)\s+application|${AI_TERM}[^?]{0,40}(?:to\s+(?:write|draft|complete|prepare)|generated|assist(?:ed|ance)\s+(?:with|in))|(?:did|have) you (?:use|used)[^?]{0,30}${AI_TERM}`,
  "i",
);
const AI_DESC = [
  new RegExp(String.raw`${AI_TERM}\s+(?:usage\s+|use\s+)?policy\s+for\s+(?:applicants|candidates|applications?)`, "i"),
  new RegExp(String.raw`(?:do not|don't|please (?:do not|refrain from)|without|refrain from)\s+(?:the\s+)?(?:use|using)\s+(?:of\s+)?(?:any\s+)?${AI_TERM}[^.\n]{0,80}(?:appl|answer|respon|interview|submission|cover letter)`, "i"),
  new RegExp(String.raw`${AI_TERM}[- ](?:generated|written|assisted)\s+(?:applications?|responses?|answers?|submissions?|cover letters?)`, "i"),
];

export function detectAiPolicy(input: { aiDisclaimer: string | null; questions: ApplicationQuestion[] | null; descriptionText: string }): AiPolicyResult {
  const parts: string[] = [];
  if (input.aiDisclaimer) parts.push(`Employer disclaimer: ${input.aiDisclaimer.slice(0, 600)}`);
  for (const q of input.questions ?? []) {
    if (AI_QUESTION.test(q.label)) parts.push(`Application question${q.required ? " (required)" : ""}: ${q.label}${q.options?.length ? ` [options: ${q.options.join(" / ")}]` : ""}`);
  }
  for (const re of AI_DESC) {
    const s = snippet(input.descriptionText, re);
    if (s) parts.push(`Posting text: ${s}`);
  }
  return parts.length ? { detected: true, text: parts.join("\n") } : { detected: false, text: null };
}

// ---------- role family ----------

export function classifyRole(title: string, cfg: { engineering_title_patterns: string[]; excluded_title_patterns: string[] }): { ok: boolean; reason: string } {
  const excluded = cfg.excluded_title_patterns.find((p) => new RegExp(p, "i").test(title));
  if (excluded) return { ok: false, reason: `title excluded by rule /${excluded}/` };
  const eng = cfg.engineering_title_patterns.some((p) => new RegExp(p, "i").test(title));
  if (!eng) return { ok: false, reason: "title does not match the target titles (roles.engineering_title_patterns)" };
  return { ok: true, reason: "matches a target title" };
}
