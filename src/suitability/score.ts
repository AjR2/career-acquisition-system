import { DEFAULT_TARGET, type Target } from "../config/target.js";
import type { EligibilityResult } from "../eligibility/rules.js";
import type { PostingAnalysis } from "./analyze.js";

/** Key names are historical: technical_alignment = skills fit, ai_native_culture = team fit (target-defined). */
export interface Weights {
  technical_alignment: number;
  ai_native_culture: number;
  compensation: number;
  experience_alignment: number;
  career_development: number;
}

export interface FactorScore {
  score: number; // 0..1
  known: boolean;
  explanation: string;
}

export interface Suitability {
  score: number; // 0..1, weighted
  factors: Record<keyof Weights, FactorScore>;
  explanation: string;
}

/** Below neutral on purpose: unknown information is never resolved in the candidate's favor (spec 9). */
const UNKNOWN = 0.4;

const norm = (s: string) => s.toLowerCase().replace(/\.js$/, "").replace(/[^a-z0-9+#]/g, "");

export interface Preferences {
  deprioritized_work: { label: string; pattern: string; scope: "title" | "title_and_responsibilities"; fit: number; source: string }[];
  target_titles: { primary: { bonus: number; pattern: string }; secondary: { bonus: number; pattern: string } };
}

export const NO_PREFERENCES: Preferences = { deprioritized_work: [], target_titles: { primary: { bonus: 0, pattern: "$^" }, secondary: { bonus: 0, pattern: "$^" } } };

/**
 * User-owned preferences (config/preferences.yaml) refine the model's coarse role_focus:
 * work the user does not want lowers focus fit; spec target titles raise career development.
 */
export function applyPreferences(title: string, responsibilities: string[], prefs: Preferences): { deprioritized?: { label: string; fit: number }; titleBonus: number; titleMatch?: string } {
  // The work must be in the title, or (when scoped to responsibilities) in at least two of them:
  // one passing mention ("contribute to the design system") does not define the role.
  const hit = prefs.deprioritized_work.find((d) => {
    const re = new RegExp(d.pattern, "i");
    if (re.test(title)) return true;
    return d.scope === "title_and_responsibilities" && responsibilities.filter((r) => re.test(r)).length >= 2;
  });
  const p = prefs.target_titles.primary;
  const s2 = prefs.target_titles.secondary;
  const titleBonus = new RegExp(p.pattern, "i").test(title) ? p.bonus : new RegExp(s2.pattern, "i").test(title) ? s2.bonus : 0;
  return { deprioritized: hit ? { label: hit.label, fit: hit.fit } : undefined, titleBonus, titleMatch: titleBonus ? (titleBonus === p.bonus ? "primary target title" : "secondary target title") : undefined };
}

export function scoreSuitability(
  a: PostingAnalysis,
  e: Pick<EligibilityResult, "comp" | "location" | "flags">,
  candidateStack: string[],
  w: Weights,
  targetBase = 150000,
  title = "",
  prefs: Preferences = NO_PREFERENCES,
  t: Target = DEFAULT_TARGET,
): Suitability {
  const pref = applyPreferences(title, a.core_responsibilities, prefs);
  // A stored analysis may name a category the target no longer has: treat it as "other".
  const cat = t.focus_categories.find((c) => c.id === a.role_focus) ?? t.focus_categories.find((c) => c.id === "other")!;
  const focus = cat.id;
  const mine = new Set(candidateStack.map(norm));

  // Technical alignment: stack overlap and role focus.
  const stack = a.primary_stack.filter(Boolean);
  const overlap = stack.filter((s) => mine.has(norm(s)));
  const focusFit = pref.deprioritized ? Math.min(pref.deprioritized.fit, cat.fit) : cat.fit;
  const focusLabel = `${focus.replace("_", " ")}${pref.deprioritized ? ` (deprioritized: ${pref.deprioritized.label})` : ""}`;
  let tech: FactorScore;
  if (!stack.length) {
    // Stack unknown (scored at UNKNOWN), role focus known: a partial factor.
    tech = { score: (UNKNOWN + focusFit) / 2, known: true, explanation: `No required skills named (scored as unknown); role focus is ${focusLabel}.` };
  } else {
    const ratio = overlap.length / stack.length;
    let s = 0.5 * ratio + 0.5 * focusFit;
    if (a.model_training_heavy) s *= 0.5;
    tech = {
      score: s,
      known: true,
      explanation: `Skills overlap ${overlap.length}/${stack.length}${overlap.length ? ` (${overlap.join(", ")})` : ""}; missing ${stack.filter((x) => !mine.has(norm(x))).join(", ") || "none"}. Role focus: ${focusLabel}${a.model_training_heavy ? `; core work is ${t.off_target_core} (penalized)` : ""}.`,
    };
  }

  // Team fit (the target's signal, e.g. AI-native engineering): grounded in quotes from the posting only.
  const n = a.ai_native_signals.length;
  const ai: FactorScore = n
    ? { score: n >= 3 ? 1 : n === 2 ? 0.85 : 0.6, known: true, explanation: `${n} ${t.team_fit.label} signal(s): "${a.ai_native_signals.slice(0, 2).join('"; "')}"` }
    : { score: 0.2, known: false, explanation: `No evidence in the posting that ${t.team_fit.signal_description}.` };

  // Compensation: base only.
  let comp: FactorScore;
  const baseMax = e.comp.baseMax;
  if (e.comp.status === "BASE_KNOWN" && baseMax != null) {
    const full = Math.round((targetBase * 4) / 3); // full marks at a third above target ($200k for a $150k target)
    const s = baseMax >= full ? 1 : baseMax >= targetBase ? 0.75 + (0.25 * (baseMax - targetBase)) / (full - targetBase) : 0.5;
    comp = { score: s, known: true, explanation: `Base up to $${baseMax.toLocaleString("en-US")}${baseMax < targetBase ? ` (below the $${Math.round(targetBase / 1000)}k target)` : ""}.` };
  } else {
    comp = { score: UNKNOWN, known: false, explanation: e.comp.status === "NON_BASE_ONLY" ? "Only OTE/total pay stated; base unknown." : "Base salary not advertised." };
  }

  // Experience alignment: seniority and stated years.
  // Seniority fit by distance from the target level; a level below is easier than a level above.
  const LEVELS = ["junior", "mid", "senior", "staff_plus"] as const;
  const BY_DISTANCE: Record<number, number> = { [-3]: 0.4, [-2]: 0.6, [-1]: 0.8, 0: 1, 1: 0.7, 2: 0.2, 3: 0.1 };
  const senFitOf = (lvl: PostingAnalysis["seniority"]) =>
    lvl === "unknown" ? UNKNOWN : BY_DISTANCE[LEVELS.indexOf(lvl) - LEVELS.indexOf(t.experience.preferred_seniority)] ?? 0.1;
  const yrs = a.years_required;
  const Y = t.experience.years;
  const yrsFit = yrs == null ? UNKNOWN : yrs <= Y ? 1 : yrs <= Y + 2 ? 0.75 : yrs <= Y + 4 ? 0.45 : 0.2;
  const exp: FactorScore = {
    score: (senFitOf(a.seniority) + yrsFit) / 2,
    known: a.seniority !== "unknown" || yrs != null,
    explanation: `Seniority ${a.seniority.replace("_", "+")}; ${yrs == null ? "years not stated" : `${yrs}+ years required`}.`,
  };

  // Career development toward the target field (goal_label).
  const devBase = pref.deprioritized ? Math.min(pref.deprioritized.fit, cat.growth) : cat.growth;
  const dev: FactorScore = {
    score: Math.min(1, devBase + pref.titleBonus),
    known: true,
    explanation: `Builds toward ${t.goal_label}: ${focusLabel}${pref.titleMatch ? `; ${pref.titleMatch}` : ""}.`,
  };

  const factors = { technical_alignment: tech, ai_native_culture: ai, compensation: comp, experience_alignment: exp, career_development: dev };
  const total = (Object.keys(w) as (keyof Weights)[]).reduce((s, k) => s + w[k] * factors[k].score, 0);
  const wsum = Object.values(w).reduce((s, x) => s + x, 0);
  const score = Math.round((total / wsum) * 1000) / 1000;

  const office = e.flags.find((f) => f.code === "OFFICE_DAYS_HIGH");
  const lines = [
    `Score ${Math.round(score * 100)}/100. ${a.summary}`,
    `${t.skills_label} (${Math.round(w.technical_alignment * 100)}%): ${tech.explanation}`,
    `${t.team_fit.label} (${Math.round(w.ai_native_culture * 100)}%): ${ai.explanation}`,
    `Pay (${Math.round(w.compensation * 100)}%): ${comp.explanation}`,
    `Experience (${Math.round(w.experience_alignment * 100)}%): ${exp.explanation}`,
    `Growth (${Math.round(w.career_development * 100)}%): ${dev.explanation}`,
  ];
  if (office) lines.push(`Note: ${office.detail}.`);
  return { score, factors, explanation: lines.join("\n") };
}
