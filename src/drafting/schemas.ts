import { z } from "zod";

export const BlockSchema = z.object({
  text: z.string().describe("One sentence or one resume bullet."),
  kind: z.enum(["fact", "framing"]).describe("fact = states something about the candidate and must cite claims. framing = no facts, e.g. why this role."),
  claim_ids: z.array(z.string()).describe("IDs of the approved claims that support this text. Required for fact blocks; empty for framing."),
});

const EntrySchema = (headingHelp: string) =>
  z.object({
    heading: z.string().describe(headingHelp),
    heading_claim_ids: z.array(z.string()),
    bullets: z.array(BlockSchema).describe("1 to 4 bullets, most relevant to the posting first."),
  });

export const ResumeDraftSchema = z.object({
  summary: z.array(BlockSchema).describe("2 to 3 sentences, position first."),
  experience: z
    .array(EntrySchema('Employment or own-company line, e.g. "Senior Engineer | Example Corp | 2023 – Present". Heading must cite a role- claim. Titles and dates exactly as in the claims.'))
    .describe("2 to 5 roles (role- claims only), most relevant first. Self-built tools never go here."),
  projects: z
    .array(EntrySchema('Project line, e.g. "Project Name | Oct 2026 – Present". Heading cites the project\'s own claims, never a role- claim.'))
    .describe("1 to 4 self-built systems or side work, most relevant first."),
  skills: BlockSchema.describe("One line of skills relevant to the posting, drawn only from the technical-skills claim and project claims."),
});
export type ResumeDraft = z.infer<typeof ResumeDraftSchema>;

export const CoverLetterSchema = z.object({
  paragraphs: z.array(z.object({ blocks: z.array(BlockSchema) })).describe("3 to 4 short paragraphs of prose."),
});
export type CoverLetter = z.infer<typeof CoverLetterSchema>;

export const VoiceReviewSchema = z.object({
  verdict: z.enum(["pass", "revise"]),
  issues: z.array(
    z.object({
      quote: z.string().describe("The exact phrase from the draft."),
      rule: z.string().describe("Which voice rule it breaks."),
      severity: z.enum(["major", "minor"]).describe("major = clearly breaks a stated rule or reads artificial; minor = polish."),
      fix: z.string().describe("A plainer replacement that keeps the meaning and adds no new facts."),
    }),
  ),
});
export type VoiceReview = z.infer<typeof VoiceReviewSchema>;

export function resumeBlocks(d: ResumeDraft) {
  return [
    ...d.summary,
    ...[...d.experience, ...(d.projects ?? [])].flatMap((e) => [{ text: e.heading, kind: "fact" as const, claim_ids: e.heading_claim_ids }, ...e.bullets]),
    d.skills,
  ];
}

export function coverLetterBlocks(c: CoverLetter) {
  return c.paragraphs.flatMap((p) => p.blocks);
}
