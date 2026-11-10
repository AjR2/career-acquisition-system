import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROJECT_ROOT } from "./env.js";

/**
 * The job target: what kind of role this install looks for. Written by the setup walkthrough
 * (`npm run cas -- setup-target`). Everything field-specific that scoring, analysis, and drafting
 * need lives here, so the same system works for engineering, product, design, data, and other roles.
 */
export const TargetSchema = z.object({
  version: z.literal(1),
  goal_label: z.string().min(1).describe("2-4 words, e.g. 'AI product engineering'"),
  role_description: z.string().min(1),
  skills_label: z.string().default("Skills"),
  focus_categories: z
    .array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]*$/), description: z.string(), fit: z.number().min(0).max(1), growth: z.number().min(0).max(1) }))
    .min(2)
    .refine((cs) => cs.some((c) => c.id === "other"), "focus_categories must include an 'other' category"),
  team_fit: z.object({ label: z.string(), signal_description: z.string() }),
  off_target_core: z.string().describe("Core work that halves skills fit, e.g. 'training ML models rather than building products'"),
  experience: z.object({ preferred_seniority: z.enum(["junior", "mid", "senior", "staff_plus"]), years: z.number().min(0) }),
  extra_skill_synonyms: z.array(z.string()).default([]),
  role_honesty_note: z.string().default("Describe the candidate's real role and responsibilities accurately."),
});
export type Target = z.infer<typeof TargetSchema>;

/** Built-in default: the software engineering target this system was first tuned on. */
export const DEFAULT_TARGET: Target = {
  version: 1,
  goal_label: "AI product engineering",
  role_description: "AI-native software engineering: building products and features on top of LLMs, full-stack and product engineering, forward-deployed engineering.",
  skills_label: "Technical",
  focus_categories: [
    { id: "ai_application", description: "builds AI/LLM-powered products or features", fit: 1, growth: 1 },
    { id: "product_engineering", description: "general product or full-stack engineering", fit: 0.9, growth: 0.85 },
    { id: "forward_deployed", description: "customer-facing engineering that deploys the product for clients", fit: 0.8, growth: 0.8 },
    { id: "infrastructure", description: "platform, infrastructure, systems, or reliability engineering", fit: 0.45, growth: 0.5 },
    { id: "data", description: "data engineering, analytics, or data pipelines", fit: 0.3, growth: 0.35 },
    { id: "security", description: "security engineering", fit: 0.25, growth: 0.3 },
    { id: "ml_research", description: "ML research or model training", fit: 0.15, growth: 0.3 },
    { id: "other", description: "anything else", fit: 0.4, growth: 0.4 },
  ],
  team_fit: { label: "AI-native", signal_description: "the team builds AI/LLM products or uses AI coding agents in its own engineering" },
  off_target_core: "training or researching ML models rather than building products on them",
  experience: { preferred_seniority: "mid", years: 3 },
  extra_skill_synonyms: ["LLM", "agents", "AI agents", "Node.js", "SQL", "REST", "APIs", "AI"],
  role_honesty_note: "Describe their real role: specifying, architecting, directing agents, testing, deploying, operating.",
};

export const TARGET_FILE = path.join(PROJECT_ROOT, "config", "target.yaml");

export function loadTarget(file = TARGET_FILE): Target {
  if (!existsSync(file)) return DEFAULT_TARGET;
  return TargetSchema.parse(YAML.parse(readFileSync(file, "utf8")));
}
