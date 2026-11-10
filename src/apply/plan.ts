import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { PROJECT_ROOT } from "../config/env.js";
import type { ApplicationQuestion } from "../discovery/types.js";
import type { Profile } from "../drafting/render.js";

export interface StandardAnswer {
  question: string;
  answer: string | number | null;
  status: "USER_CONFIRMED" | "PENDING";
}

export type PlanSource = "profile" | "standard" | "resume_file" | "user" | "eeo_manual" | "attestation" | "skip_optional";

export interface PlanItem {
  label: string;
  required: boolean;
  source: PlanSource;
  key?: string; // profile field or standard-answer key
  value?: string;
  reason?: string;
  fieldTypes: string[];
  options?: string[];
}

export interface ApplicationPlan {
  items: PlanItem[];
  /** Required questions the system cannot answer from approved data. Approval needs the user's answers. */
  needsUser: PlanItem[];
  eeo: PlanItem[];
  /** Legal declarations, agreements, attestations: shown in the queue, completed only by the user in the browser. */
  declarations: PlanItem[];
  known: boolean; // false when the ATS exposes no question list (Lever, Ashby)
}

export function loadStandardAnswers(file = path.join(PROJECT_ROOT, "config", "standard-answers.yaml")): Record<string, StandardAnswer & Record<string, unknown>> {
  return YAML.parse(readFileSync(file, "utf8"));
}

const PROFILE_RULES: [RegExp, keyof Profile | "first_name" | "last_name"][] = [
  [/^first name|preferred first name|^legal first name/i, "first_name"],
  [/^last name|^legal last name|surname/i, "last_name"],
  [/^e-?mail/i, "email"],
  [/^phone|mobile/i, "phone"],
  [/linkedin/i, "linkedin"],
  [/github/i, "github"],
];

// Standard answers matched by question wording. Order matters (most specific first).
const STANDARD_RULES: [RegExp, string][] = [
  [/(currently|presently) hold.*clearance|active.*clearance|possess.*clearance|^do you (have|hold) an? (active |current )?(security |government )?clearance/i, "active_clearance"],
  [/(willing|able|eligible).*(obtain|get).*clearance/i, "clearance_willingness"],
  [/(require|need).*(visa|sponsor)|sponsorship/i, "sponsorship"],
  [/(legally )?authori[sz]ed to work|work authori[sz]ation|eligible to work in the (u\.?s|united states)/i, "work_authorization"],
  [/what is the address|address from which|where (do|will) you plan (on|to) work|where are you (located|based)|current (city|location)/i, "location"],
  [/(willing|open|able) to relocate|open to relocation|relocat(e|ion) for this role/i, "relocation"],
  [/(in[- ]person|on[- ]?site|hybrid|in (the|our|one of our) offices?)/i, "hybrid_onsite"],
  [/(at least|over) 18|18 years/i, "age_18_plus"],
  [/salary|compensation expectation|desired (pay|compensation)/i, "desired_salary_text"],
  [/start date|when can you start|earliest.*start/i, "start_date"],
  [/how did you hear|where did you (hear|find)|referr(al|ed) source/i, "referral_source"],
  [/^location$|^current location|city,? state/i, "location"],
];

const EEO = /gender|race|ethnicit|hispanic|latino|veteran|disabilit|pronoun|sexual orientation|transgender|demographic/i;
const DECLARATION = /arbitrat|agreement|\bagree\b|attest|certify|acknowledg|consent|terms (and|&) conditions|privacy (notice|policy)|i understand|declaration|signature/i;
const AI_POLICY = /\bAI\b.*polic|artificial intelligence.*polic|use of (AI|generative)/i;

function splitName(name: string): { first_name: string; last_name: string } {
  const parts = name.trim().split(/\s+/);
  return { first_name: parts[0] ?? "", last_name: parts.slice(1).join(" ") };
}

export function buildPlan(questions: ApplicationQuestion[] | null, profile: Profile, answers: ReturnType<typeof loadStandardAnswers>, userAnswers: Record<string, string> = {}): ApplicationPlan {
  if (!questions) return { items: [], needsUser: [], eeo: [], declarations: [], known: false };
  const names = splitName(profile.name);
  const items: PlanItem[] = [];

  for (const q of questions) {
    const base = { label: q.label, required: q.required, fieldTypes: q.fieldTypes, options: q.options };
    const user = userAnswers[q.label];
    if (EEO.test(q.label)) {
      items.push({ ...base, source: "eeo_manual", reason: "voluntary demographic question; CAS never answers these" });
      continue;
    }
    if (DECLARATION.test(q.label)) {
      items.push({ ...base, source: "attestation", reason: "legal declaration or agreement: you read and complete it in the browser; CAS never fills it" });
      continue;
    }
    if (q.fieldTypes.includes("input_file") && /resume|cv/i.test(q.label)) {
      items.push({ ...base, source: "resume_file", reason: "approved resume PDF" });
      continue;
    }
    if (AI_POLICY.test(q.label)) {
      items.push(user ? { ...base, source: "user", value: user, reason: "your answer" } : { ...base, source: "user", reason: "employer AI-use policy question: you answer this one (decision 0003)" });
      continue;
    }
    const prof = PROFILE_RULES.find(([re]) => re.test(q.label));
    if (prof) {
      const k = prof[1];
      const v = k === "first_name" || k === "last_name" ? names[k] : profile[k];
      items.push({ ...base, source: "profile", key: k, value: v });
      continue;
    }
    const std = STANDARD_RULES.find(([re]) => re.test(q.label));
    if (std) {
      const key = std[1];
      const a = answers[key] as StandardAnswer | undefined;
      if (a && a.status === "USER_CONFIRMED" && a.answer != null) {
        const v = String(a.answer);
        // A select field takes the answer only if it is exactly one of the options. Never shorten a
        // conditional answer ("Yes, within the DC metro") to a bare "Yes".
        const opt = q.options?.length ? q.options.find((o) => o.trim().toLowerCase() === v.trim().toLowerCase()) : undefined;
        if (!q.options?.length || opt) {
          items.push({ ...base, source: "standard", key, value: opt ?? v });
          continue;
        }
        if (user) {
          items.push({ ...base, source: "user", value: user, key, reason: "your answer for this application" });
          continue;
        }
        items.push({ ...base, source: q.required ? "user" : "skip_optional", key, reason: `standard answer "${v}" does not match the form's options (${q.options.join(" / ")})` });
        continue;
      }
      if (user) {
        items.push({ ...base, source: "user", value: user, key, reason: `standard answer "${key}" is ${a ? a.status : "missing"}; using your answer for this application` });
        continue;
      }
      items.push({ ...base, source: q.required ? "user" : "skip_optional", key, reason: `standard answer "${key}" is ${a ? a.status : "missing"}` });
      continue;
    }
    if (user) {
      items.push({ ...base, source: "user", value: user, reason: "your answer" });
      continue;
    }
    items.push({ ...base, source: q.required ? "user" : "skip_optional", reason: q.required ? "no approved answer; you answer this one" : "optional; left blank" });
  }
  const needsUser = items.filter((i) => i.required && i.source === "user" && !i.value);
  return { items, needsUser, eeo: items.filter((i) => i.source === "eeo_manual"), declarations: items.filter((i) => i.source === "attestation"), known: true };
}
