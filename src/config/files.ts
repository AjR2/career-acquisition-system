import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROJECT_ROOT } from "./env.js";

export const EligibilityConfigSchema = z.object({
  candidate: z.object({ has_active_clearance: z.boolean() }),
  compensation: z.object({
    min_base_usd: z.number().positive(),
    target_base_usd: z.number().positive(),
    hours_per_year: z.number().positive(),
  }),
  location: z.object({
    home: z.string(),
    remote_ok: z.boolean().default(true),
    dc_metro: z.array(z.string()),
    office_days_high_threshold: z.number().min(1).max(5),
  }),
  roles: z.object({
    engineering_title_patterns: z.array(z.string()).min(1),
    excluded_title_patterns: z.array(z.string()),
    /** Part-time, per-diem, and PRN roles: kept (flagged) when true, rejected when false. */
    part_time_ok: z.boolean().default(false),
  }),
});
export type EligibilityConfig = z.infer<typeof EligibilityConfigSchema>;

export const CompanySchema = z.object({
  name: z.string(),
  ats: z.enum(["greenhouse", "lever", "ashby"]),
  token: z.string().regex(/^[A-Za-z0-9._-]+$/),
  priority: z.enum(["A", "B"]),
  remote_first: z.boolean().optional(),
  open_eng: z.number().optional(),
  note: z.string().optional(),
});
export const CompaniesFileSchema = z.object({ companies: z.array(CompanySchema) });

export function loadEligibilityConfig(file = path.join(PROJECT_ROOT, "config", "eligibility.yaml")): EligibilityConfig {
  return EligibilityConfigSchema.parse(YAML.parse(readFileSync(file, "utf8")));
}

export function loadCompanies(file = path.join(PROJECT_ROOT, "config", "companies.yaml")) {
  const parsed = CompaniesFileSchema.parse(YAML.parse(readFileSync(file, "utf8")));
  const seen = new Set<string>();
  for (const c of parsed.companies) {
    const k = `${c.ats}:${c.token}`;
    if (seen.has(k)) throw new Error(`Duplicate company entry ${k}`);
    seen.add(k);
  }
  return parsed.companies;
}
