import type { Claim } from "../evidence/claims.js";
import { isUsable, usableClaims } from "../evidence/claims.js";
import { isApprovedWording, PRONOUN, wordingKey, type ApprovedWording } from "../evidence/wording.js";
import type { LlmClient } from "../llm/client.js";
import type { PostingAnalysis } from "../suitability/analyze.js";
import { validateClaims, type ClaimIssue } from "../validate/claims-validator.js";
import { lint, type BannedConfig, type LintViolation } from "../validate/linter.js";
import { resumeSystem, resumeUser, voiceSystem } from "./prompts.js";
import { renderResume, type Profile } from "./render.js";
import { resumeBlocks, ResumeDraftSchema, VoiceReviewSchema, type ResumeDraft, type VoiceReview } from "./schemas.js";

export interface DraftDeps {
  /** From the job target: how to describe the candidate's real role. */
  roleNote?: string;
  llm: LlmClient;
  claims: Claim[];
  banned: BannedConfig;
  techTerms: string[];
  voiceProfile: string;
  profile: Profile;
  draftModel: string;
  reviewModel: string;
  /** Bullet wording the user already approved, keyed by claim set (see evidence/wording.ts). */
  approvedWording?: Map<string, ApprovedWording>;
  /** enforce (new drafts): approved wording must be reused verbatim. prefer (revisions): reuse it unless the user's note asks for a change; approving the revision replaces it. */
  wordingMode?: "enforce" | "prefer";
}

export interface Validation {
  passed: boolean;
  schemaError?: string;
  claimIssues: ClaimIssue[];
  lint: LintViolation[];
  voice?: VoiceReview;
  structure: string[];
}

export interface Attempt {
  attempt: number;
  draft?: ResumeDraft;
  rendered?: string;
  validation: Validation;
}

export interface DraftOutcome {
  ok: boolean;
  attempts: Attempt[];
  reason?: string;
}

/** Convention (like edu-/pub- in render.ts): employment and own-company headings cite claims whose id starts with "role-". */
const isRoleClaim = (id: string) => id.startsWith("role-");

export function structureIssues(d: ResumeDraft, claims: Claim[] = [], approved: Map<string, ApprovedWording> = new Map()): string[] {
  const out: string[] = [];
  const projects = d.projects ?? [];
  const entries = [...d.experience, ...projects];
  const bullets = entries.reduce((n, e) => n + e.bullets.length, 0);
  if (d.summary.length < 1 || d.summary.length > 3) out.push(`summary has ${d.summary.length} sentences (want 2 to 3)`);
  if (d.experience.length < 2 || d.experience.length > 5) out.push(`${d.experience.length} experience entries (want 2 to 5)`);
  if (projects.length > 4) out.push(`${projects.length} project entries (want at most 4)`);
  if (bullets > 16) out.push(`${bullets} bullets (want 10 to 14 for one page)`);
  for (const e of d.experience) {
    if (!e.heading_claim_ids.some(isRoleClaim)) out.push(`"${e.heading}" is under Experience but cites no role- claim; self-built work belongs under Projects`);
  }
  for (const e of projects) {
    if (e.heading_claim_ids.some(isRoleClaim)) out.push(`"${e.heading}" is under Projects but cites a role- claim; employment belongs under Experience`);
  }
  // Resume voice rule: fragments, no pronouns. Deterministic, so it does not depend on the voice review noticing.
  for (const b of resumeBlocks(d)) {
    const m = b.text.match(PRONOUN);
    if (m) out.push(`pronoun "${m[0]}" in "${b.text.slice(0, 80)}"; resume text uses no pronouns`);
  }
  // Approved wording is reused verbatim: the user reviews a sentence once.
  for (const e of entries) {
    for (const b of e.bullets) {
      const a = approved.get(wordingKey(b.claim_ids));
      if (a && !isApprovedWording(b.text, b.claim_ids, approved)) out.push(`bullet citing [${a.claimIds.join(", ")}] has approved wording; use it exactly: "${a.text}"`);
    }
  }
  const cited = new Set(resumeBlocks(d).flatMap((b) => b.claim_ids));
  for (const c of claims) {
    if (c.always_include && isUsable(c, "resume") && !cited.has(c.id)) out.push(`required claim "${c.id}" is missing; every resume must include it`);
  }
  return out;
}

export function feedbackText(v: Validation): string {
  const lines: string[] = [];
  if (v.schemaError) lines.push(`- Output was not valid: ${v.schemaError}`);
  for (const i of v.claimIssues) lines.push(`- [${i.problem}] "${i.block.slice(0, 120)}": ${i.detail}`);
  for (const l of v.lint) lines.push(`- Banned ${l.rule === "banned_character" ? "character" : "phrase"} "${l.match}" in: "${l.context}"`);
  for (const s of v.structure) lines.push(`- Structure: ${s}`);
  for (const i of v.voice?.issues.filter((x) => x.severity === "major") ?? []) lines.push(`- Voice (${i.rule}): "${i.quote}" -> ${i.fix}`);
  return lines.join("\n");
}

export async function validateResume(d: ResumeDraft, deps: DraftDeps, postingText: string, postingId?: number): Promise<{ rendered: string; validation: Validation }> {
  const rendered = renderResume(d, deps.profile, deps.claims);
  const claimIssues = validateClaims(resumeBlocks(d), deps.claims, "resume", { techTerms: deps.techTerms, postingText });
  const lintResult = lint(resumeBlocks(d).map((b) => b.text).join("\n"), deps.banned);
  const structure = structureIssues(d, deps.claims, deps.wordingMode === "prefer" ? undefined : deps.approvedWording);
  let voice: VoiceReview | undefined;
  // Voice review is a model call: only spend it once the deterministic checks pass.
  if (!claimIssues.length && !lintResult.length) {
    const r = await deps.llm.parse({
      purpose: "voice_review",
      model: deps.reviewModel,
      system: voiceSystem(deps.profile.name),
      user: `VOICE PROFILE:\n${deps.voiceProfile}\n\nDRAFT (resume):\n${rendered}`,
      schema: VoiceReviewSchema,
      maxTokens: 2000,
      effort: "low",
      postingId,
    });
    voice = r.ok ? r.data : { verdict: "revise", issues: [{ quote: "", rule: "voice review unavailable", severity: "major", fix: r.error }] };
  }
  const passed = !claimIssues.length && !lintResult.length && !structure.length && voice?.verdict === "pass";
  return { rendered, validation: { passed, claimIssues, lint: lintResult, voice, structure } };
}

/**
 * Generate, validate, retry once with the problems as feedback. Two failures = not ok
 * (the caller moves the posting to NEEDS_ATTENTION). Never returns an unvalidated draft as ok.
 */
export async function draftResume(
  deps: DraftDeps,
  posting: { company: string; title: string; text: string },
  analysis: PostingAnalysis | null,
  postingId?: number,
  userFeedback?: string,
): Promise<DraftOutcome> {
  const claims = usableClaims(deps.claims, "resume");
  const system = resumeSystem(deps.voiceProfile, deps.banned.phrases, deps.profile.name, deps.roleNote);
  const attempts: Attempt[] = [];
  let feedback: string | undefined = userFeedback ? `The candidate reviewed the previous version and asked for this change (follow it unless it would break a hard rule):\n${userFeedback}` : undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await deps.llm.parse({
      purpose: attempt === 1 ? "draft_resume" : "draft_resume_retry",
      model: deps.draftModel,
      system,
      user: resumeUser(claims, posting, analysis, feedback, [...(deps.approvedWording?.values() ?? [])], deps.wordingMode ?? "enforce"),
      schema: ResumeDraftSchema,
      maxTokens: 6000,
      effort: "medium",
      postingId,
    });
    if (!r.ok) {
      const validation: Validation = { passed: false, schemaError: r.error, claimIssues: [], lint: [], structure: [] };
      attempts.push({ attempt, validation });
      if (!r.retryable) break;
      feedback = feedbackText(validation);
      continue;
    }
    const { rendered, validation } = await validateResume(r.data, deps, posting.text, postingId);
    attempts.push({ attempt, draft: r.data, rendered, validation });
    if (validation.passed) return { ok: true, attempts };
    feedback = feedbackText(validation);
  }
  const last = attempts[attempts.length - 1]!.validation;
  return { ok: false, attempts, reason: `resume failed validation twice: ${feedbackText(last).split("\n").slice(0, 3).join(" | ")}` };
}
