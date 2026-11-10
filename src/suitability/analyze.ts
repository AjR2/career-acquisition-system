import { z } from "zod";
import { DEFAULT_TARGET, type Target } from "../config/target.js";
import type { NormalizedPosting } from "../discovery/types.js";
import { asData, UNTRUSTED_NOTICE, type LlmClient, type ParseResult } from "../llm/client.js";

/**
 * Field names are kept stable for stored analyses; their meaning comes from the job target:
 *  - primary_stack: skills, tools, and technologies the posting requires
 *  - ai_native_signals: evidence for the target's team-fit signal (label varies by target)
 *  - role_focus: one of the target's focus category ids
 *  - model_training_heavy: core work matches the target's off_target_core description
 */
export function buildAnalysisSchema(t: Target) {
  const ids = t.focus_categories.map((c) => c.id) as [string, ...string[]];
  return z.object({
    summary: z.string().describe("Two plain sentences on what the person in this role actually does day to day."),
    core_responsibilities: z.array(z.string()).describe("3 to 6 main responsibilities, paraphrased from the posting."),
    primary_stack: z.array(z.string()).describe("Skills, tools, and technologies the posting names as required or primary. Empty if none named."),
    ai_native_signals: z.array(z.string()).describe(`Short verbatim quotes (under 20 words each) showing that ${t.team_fit.signal_description}. Empty if none.`),
    role_focus: z.enum(ids).describe(`Which category best describes the core work: ${t.focus_categories.map((c) => `${c.id} = ${c.description}`).join("; ")}.`),
    seniority: z.enum(["junior", "mid", "senior", "staff_plus", "unknown"]),
    years_required: z.number().nullable().describe("Minimum years of experience stated in the posting, or null if not stated."),
    model_training_heavy: z.boolean().describe(`True only if the core work is ${t.off_target_core}.`),
  });
}

export const PostingAnalysisSchema = buildAnalysisSchema(DEFAULT_TARGET);
export type PostingAnalysis = Omit<z.infer<typeof PostingAnalysisSchema>, "role_focus"> & { role_focus: string };

function system(t: Target): string {
  return `You extract structured facts from a job posting for a candidate's private job-search tool.
The candidate is looking for: ${t.role_description}
${UNTRUSTED_NOTICE}
Rules:
- Report only what the posting says. If something is not stated, use null, "unknown", or an empty list. Never guess in the candidate's favor.
- ai_native_signals must be short verbatim quotes from the posting showing that ${t.team_fit.signal_description}. Company boilerplate counts only if it describes the team's actual work.
- Be concise.`;
}

export function analyzePosting(llm: LlmClient, p: NormalizedPosting, model: string, postingId?: number, target: Target = DEFAULT_TARGET): Promise<ParseResult<PostingAnalysis>> {
  const text = p.descriptionText.slice(0, 24000);
  return llm.parse({
    purpose: "posting_analysis",
    model,
    system: system(target),
    user: `Company: ${p.companyName}\nTitle: ${p.title}\nLocation: ${p.locationRaw}\n\n${asData("posting", text)}`,
    schema: buildAnalysisSchema(target) as z.ZodType<PostingAnalysis>,
    maxTokens: 2000,
    effort: "low",
    postingId,
  });
}
