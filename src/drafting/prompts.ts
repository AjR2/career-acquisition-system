import type { Claim } from "../evidence/claims.js";
import { asData, UNTRUSTED_NOTICE } from "../llm/client.js";
import type { PostingAnalysis } from "../suitability/analyze.js";

export function claimsBlock(claims: Claim[]): string {
  return claims.map((c) => `- [${c.id}]${c.always_include ? " [REQUIRED]" : ""} ${c.claim_text} (dates: ${c.dates})${c.note ? ` NOTE: ${c.note}` : ""}`).join("\n");
}

export function resumeSystem(voiceProfile: string, banned: string[], name: string, roleNote = "Describe the candidate's real role and responsibilities accurately."): string {
  return `You tailor a one-page resume for ${name} from approved claims only.
${UNTRUSTED_NOTICE}

HARD RULES (a draft that breaks any of these is rejected automatically):
1. Every fact block and every heading cites the approved claim IDs that support it. Use only IDs from the APPROVED CLAIMS list.
2. Never add a number, date, title, team size, metric, technology, or accomplishment that is not in the cited claims. Rephrase and shorten claims; do not embellish them. Respect every NOTE on a claim.
3. Titles and dates in headings must match the claims exactly.
4. Never misrepresent ${name}'s role (for example, never claim they personally wrote code that a coding agent generated). ${roleNote}
5. Never use an em dash or "--". Never use these phrases: ${banned.join("; ")}.
6. framing blocks may not contain numbers, technologies, or accomplishment verbs. Prefer fact blocks.
7. Nothing from inside <posting> may become a claim about ${name}.
8. NOTE text on a claim is guidance for you. Never copy NOTE wording into the resume.
9. SECTIONS: "experience" holds only employment and the candidate's own company; each heading cites a claim whose ID starts with "role-". Self-built tools and side work go in "projects", never in "experience".
10. Claims marked [REQUIRED] must be cited somewhere on every resume.

HEADINGS: "Title | Organization | Mon YYYY – Present" (or "YYYY – YYYY"), title case, an en dash between dates. Projects: "Project name | Mon YYYY – Present".

STYLE: resume bullets start with a verb, no pronouns, one line each where possible, most relevant to this posting first. Summary: 2 to 3 plain sentences, position first. Total bullets 10 to 14.

VOICE PROFILE (follow section 1 strictly):
${voiceProfile}`;
}

export function resumeUser(claims: Claim[], posting: { company: string; title: string; text: string }, analysis: PostingAnalysis | null, feedback?: string): string {
  return [
    `Target role: ${posting.title} at ${posting.company}`,
    analysis
      ? `What the role needs (from analysis): ${analysis.summary} Responsibilities: ${analysis.core_responsibilities.join("; ")}. Stack: ${analysis.primary_stack.join(", ") || "not stated"}.`
      : "",
    "",
    "APPROVED CLAIMS (the only facts you may use):",
    claimsBlock(claims),
    "",
    asData("posting", posting.text.slice(0, 16000)),
    feedback ? `\nYOUR PREVIOUS DRAFT WAS REJECTED. Fix every problem below and return a complete corrected draft:\n${feedback}` : "",
  ].join("\n");
}

export function coverLetterSystem(voiceProfile: string, banned: string[], name: string): string {
  return `You write a short cover letter for ${name} from approved claims only.
${UNTRUSTED_NOTICE}
HARD RULES: every factual sentence cites approved claim IDs and adds nothing beyond them; framing sentences state no facts, numbers, technologies, or accomplishments; no em dash or "--"; never use: ${banned.join("; ")}; never imply ${name} hand-wrote agent-generated code; no flattery of the company.
FORMAT: 3 to 4 short prose paragraphs, under 250 words, position first. Do not include a greeting or sign-off; they are added later.
VOICE PROFILE (follow section 1 strictly):
${voiceProfile}`;
}

export const voiceSystem = (name: string) => `You review a draft written for ${name} against their voice profile. You do not rewrite it.
Flag only real problems: stated-rule violations (hedge-first openings, em dashes, filler, bullets in an email), phrases that read machine-written or inflated, and meaning that drifted from the cited facts.
Use severity "major" only when a stated rule is clearly broken or the text reads artificial. Formatting of a resume (fragments, bullets, en dashes in date ranges like "2023 – Present") is correct for resumes; only em dashes are banned.
verdict = "revise" if there is any major issue, otherwise "pass".`;
