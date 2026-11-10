import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { PROJECT_ROOT } from "../config/env.js";
import { TargetSchema, type Target } from "../config/target.js";
import type { Fetcher } from "../discovery/types.js";
import { probeCompany, type ProbeResult } from "./companies.js";

/** One question at a time. The CLI uses readline; tests use a script. */
export interface Asker {
  ask(question: string, defaultValue?: string): Promise<string>;
  say(text: string): void;
}

export type Seniority = Target["experience"]["preferred_seniority"];

export interface Answers {
  fieldLabel: string;
  roleDescription: string;
  primaryTitles: string[];
  secondaryTitles: string[];
  excludeWords: string[];
  avoidWork: string[];
  teamFitDescription: string;
  teamFitLabel: string;
  skills: string[];
  years: number;
  seniority: Seniority;
  partTimeOk: boolean;
  minBase: number;
  targetBase: number;
  home: string;
  remoteOk: boolean;
  commute: string[];
  hasClearance: boolean;
  companies: string[];
  replaceCompanies: boolean;
}

export class SetupError extends Error {}

const list = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const yes = (s: string) => /^y(es)?$/i.test(s.trim());
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HOURS_PER_YEAR = 2080;

/** "120000", "120k", "$120,000", "45/hr", "$45 an hour" -> yearly USD. NaN if unreadable. */
export function parseMoney(s: string): number {
  const hourly = /(\/|per|an?)\s*(hr|hour)\b|hourly/i.test(s);
  const num = s.replace(/(\/|per|an?\s)\s*(hr|hour).*$|hourly/i, "").replace(/[$,\s]/g, "").replace(/k$/i, "000");
  const n = Number(num);
  return num === "" || !Number.isFinite(n) ? NaN : Math.round(hourly ? n * HOURS_PER_YEAR : n);
}

const levelFor = (years: number): Seniority => (years <= 2 ? "junior" : years <= 5 ? "mid" : years <= 10 ? "senior" : "staff_plus");

/** Raw text answers keyed by question. Shared by the terminal walkthrough and the web form. */
export type RawAnswers = Record<QuestionKey, string>;
export type QuestionKey =
  | "roleDescription" | "fieldLabel" | "primaryTitles" | "secondaryTitles" | "excludeWords" | "avoidWork"
  | "teamFitDescription" | "teamFitLabel" | "skills" | "years" | "seniority" | "partTimeOk" | "minBase" | "targetBase"
  | "home" | "remoteOk" | "commute" | "hasClearance" | "companies" | "replaceCompanies";

export interface Question {
  key: QuestionKey;
  text: string;
  example?: string;
  kind: "text" | "long" | "yesno" | "money" | "number" | "choice";
  choices?: string[];
  required?: boolean;
  /** Default shown in [brackets]; may depend on earlier answers. */
  def?: (r: Partial<RawAnswers>) => string;
}

export const QUESTIONS: Question[] = [
  { key: "roleDescription", kind: "long", required: true, text: "In a sentence or two, what kind of job are you looking for?", example: "Registered nurse roles in outpatient or telehealth care" },
  { key: "fieldLabel", kind: "text", required: true, text: "What would you call that field in 2 to 4 words?", example: "outpatient nursing" },
  { key: "primaryTitles", kind: "text", required: true, text: "Job titles you would apply for, most wanted first (comma-separated). Use the core words.", example: "registered nurse, RN, nurse care manager" },
  { key: "secondaryTitles", kind: "text", text: "Other titles you would also consider (comma-separated, or leave blank)", example: "care coordinator, clinical educator", def: () => "" },
  { key: "excludeWords", kind: "text", text: "Words in a title that rule a job out (comma-separated)", example: "intern, director, travel", def: () => "intern" },
  { key: "avoidWork", kind: "text", text: "Kinds of work you would rather not do, even if the title fits (comma-separated, or leave blank)", example: "night shift, sales", def: () => "" },
  { key: "teamFitDescription", kind: "long", text: "What makes an employer a great fit for you?", example: "they provide direct patient care in an underserved community", def: () => "the work matches what I described" },
  { key: "teamFitLabel", kind: "text", text: "A short label for that (2 words)", example: "Mission fit", def: () => "Team fit" },
  { key: "skills", kind: "text", text: "Skills, tools, licenses, and certifications you hold (comma-separated). These are also checked in drafts: CAS never claims one you did not list here and confirm.", example: "BLS, ACLS, Epic, patient education", def: () => "" },
  { key: "years", kind: "number", text: "Years of relevant experience", def: () => "3" },
  { key: "seniority", kind: "choice", choices: ["junior", "mid", "senior", "staff_plus"], text: "Level you are targeting: junior, mid, senior, or staff_plus (staff_plus = lead/principal)", def: (r) => levelFor(Number(r.years) || 0) },
  { key: "partTimeOk", kind: "yesno", text: "Are part-time, per-diem, or PRN roles OK? (y/n)", def: () => "n" },
  { key: "minBase", kind: "money", required: true, text: "Lowest base pay you would accept, in USD. A yearly amount (90000 or 90k) or hourly (45/hr).", def: () => "60000" },
  { key: "targetBase", kind: "money", required: true, text: "Your target base pay (yearly or hourly)", def: (r) => { const m = parseMoney(r.minBase ?? ""); return Number.isFinite(m) ? String(Math.round(m * 1.07)) : ""; } },
  { key: "home", kind: "text", required: true, text: "Your home city and state", example: "Denver, CO" },
  { key: "remoteOk", kind: "yesno", text: "Are fully remote (US) roles OK? (y/n)", def: () => "y" },
  { key: "commute", kind: "text", text: "Cities or areas you could commute to for in-person work (comma-separated)", example: "denver, aurora, lakewood", def: (r) => (r.home ?? "").split(",")[0]?.trim() ?? "" },
  { key: "hasClearance", kind: "yesno", text: "Do you hold an ACTIVE US security clearance today? (y/n; most people answer n)", def: () => "n" },
  { key: "companies", kind: "long", text: "Employers to watch (comma-separated names), or leave blank to keep the current list", example: "Carbon Health, Cityblock Health", def: () => "" },
  { key: "replaceCompanies", kind: "yesno", text: "Replace the current employer list with these? (n = add to it)", def: () => "n" },
];

/** Checks one answer; returns an error message or null. */
export function checkAnswer(q: Question, value: string, r: Partial<RawAnswers>): string | null {
  const v = value.trim();
  if (q.required && !v) return "This one is required.";
  if (q.kind === "money" && v) {
    const n = parseMoney(v);
    if (!Number.isFinite(n) || n <= 0) return "Please enter an amount like 90000, 90k, or 45/hr.";
    if (q.key === "targetBase" && n < parseMoney(r.minBase ?? "0")) return "The target should be at least the lowest pay you would accept.";
  }
  if (q.kind === "number" && v && !(Number.isFinite(Number(v)) && Number(v) >= 0)) return "Please enter a number.";
  if (q.kind === "yesno" && v && !/^(y|yes|n|no)$/i.test(v)) return "Please answer y or n.";
  if (q.kind === "choice" && v && !q.choices!.includes(v.toLowerCase())) return `Please choose one of: ${q.choices!.join(", ")}.`;
  return null;
}

/** Validates all raw answers (defaults applied) and converts them. Throws SetupError listing problems. */
export function parseAnswers(input: Partial<RawAnswers>): Answers {
  const r: Partial<RawAnswers> = {};
  const problems: string[] = [];
  for (const q of QUESTIONS) {
    let v = (input[q.key] ?? "").trim();
    if (!v && q.def) v = q.def(r);
    const err = checkAnswer(q, v, r);
    if (err) problems.push(`${q.text}: ${err}`);
    r[q.key] = v;
  }
  if (problems.length) throw new SetupError(problems.join("\n"));
  const a = r as RawAnswers;
  const years = Number(a.years);
  const companies = list(a.companies);
  return {
    roleDescription: a.roleDescription,
    fieldLabel: a.fieldLabel,
    primaryTitles: list(a.primaryTitles),
    secondaryTitles: list(a.secondaryTitles),
    excludeWords: list(a.excludeWords),
    avoidWork: list(a.avoidWork),
    teamFitDescription: a.teamFitDescription,
    teamFitLabel: a.teamFitLabel,
    skills: list(a.skills),
    years,
    seniority: (a.seniority.toLowerCase() as Seniority) || levelFor(years),
    partTimeOk: yes(a.partTimeOk),
    minBase: parseMoney(a.minBase),
    targetBase: parseMoney(a.targetBase),
    home: a.home,
    remoteOk: yes(a.remoteOk),
    commute: list(a.commute),
    hasClearance: yes(a.hasClearance),
    companies,
    replaceCompanies: companies.length > 0 && yes(a.replaceCompanies),
  };
}

/** Terminal walkthrough: asks each question in turn and re-asks until the answer is valid. */
export async function collectAnswers(a: Asker): Promise<Answers> {
  a.say("\nJob target setup. One question at a time; press Enter to accept the value in [brackets].\n");
  const r: Partial<RawAnswers> = {};
  let n = 0;
  for (const q of QUESTIONS) {
    if (q.key === "replaceCompanies" && !list(r.companies ?? "").length) continue;
    n++;
    const def = q.def?.(r);
    for (;;) {
      const prompt = `${n}. ${q.text}${q.example ? ` (e.g. '${q.example}')` : ""}`;
      const v = (await a.ask(prompt, def)).trim();
      const err = checkAnswer(q, v, r);
      if (!err) {
        r[q.key] = v;
        break;
      }
      a.say(`   ${err}`);
    }
  }
  return parseAnswers(r);
}

export function buildTarget(x: Answers): Target {
  return TargetSchema.parse({
    version: 1,
    goal_label: x.fieldLabel || "target field",
    role_description: x.roleDescription || x.primaryTitles.join(", "),
    skills_label: "Skills",
    focus_categories: [
      { id: "core", description: x.roleDescription || x.primaryTitles.join(", "), fit: 1, growth: 1 },
      { id: "adjacent", description: x.secondaryTitles.length ? `related roles such as ${x.secondaryTitles.join(", ")}` : "closely related roles", fit: 0.7, growth: 0.6 },
      { id: "off_target", description: x.avoidWork.length ? x.avoidWork.join("; ") : "work outside the target field", fit: 0.15, growth: 0.2 },
      { id: "other", description: "anything else", fit: 0.4, growth: 0.4 },
    ],
    team_fit: { label: x.teamFitLabel || "Team fit", signal_description: x.teamFitDescription },
    off_target_core: x.avoidWork.length ? x.avoidWork.join(" or ") : "work outside the target field",
    experience: { preferred_seniority: x.seniority, years: x.years },
    extra_skill_synonyms: x.skills,
    role_honesty_note: "Describe the candidate's real role and responsibilities accurately.",
  });
}

export interface ConfigFiles {
  target: string;
  eligibility: string;
  preferences: string;
  techTerms: string;
  companies: string;
}

export const DEFAULT_PATHS = (root = PROJECT_ROOT): ConfigFiles => ({
  target: path.join(root, "config", "target.yaml"),
  eligibility: path.join(root, "config", "eligibility.yaml"),
  preferences: path.join(root, "config", "preferences.yaml"),
  techTerms: path.join(root, "config", "tech-terms.yaml"),
  companies: path.join(root, "config", "companies.yaml"),
});

/** Builds every config file from the answers, editing existing files in place to keep their comments. */
export function buildConfigs(x: Answers, current: ConfigFiles, probes: ProbeResult[], today: string): ConfigFiles {
  const target = `# Job target, written by the setup walkthrough on ${today}. Edit freely, then run: npm run cas -- score --rescore\n${YAML.stringify(buildTarget(x), { lineWidth: 0 })}`;

  const elig = YAML.parseDocument(current.eligibility);
  elig.setIn(["candidate", "has_active_clearance"], x.hasClearance);
  elig.setIn(["compensation", "min_base_usd"], x.minBase);
  elig.setIn(["compensation", "target_base_usd"], x.targetBase);
  elig.setIn(["location", "home"], x.home);
  elig.setIn(["location", "remote_ok"], x.remoteOk);
  elig.setIn(["location", "dc_metro"], x.commute.map((c) => c.toLowerCase()));
  elig.setIn(["roles", "engineering_title_patterns"], [...x.primaryTitles, ...x.secondaryTitles].map((t) => `\\b${esc(t.toLowerCase())}\\b`));
  elig.setIn(["roles", "excluded_title_patterns"], x.excludeWords.map((w) => `\\b${esc(w.toLowerCase())}\\b`));
  elig.setIn(["roles", "part_time_ok"], x.partTimeOk);

  const prefs = YAML.parseDocument(current.preferences);
  prefs.setIn(
    ["deprioritized_work"],
    x.avoidWork.map((w) => ({ label: w, pattern: esc(w.toLowerCase()), scope: "title_and_responsibilities", fit: 0.3, source: `setup walkthrough ${today}` })),
  );
  prefs.setIn(["target_titles", "primary", "pattern"], x.primaryTitles.map((t) => esc(t.toLowerCase())).join("|") || "$^");
  prefs.setIn(["target_titles", "secondary", "pattern"], x.secondaryTitles.map((t) => esc(t.toLowerCase())).join("|") || "$^");

  const terms = YAML.parseDocument(current.techTerms);
  const seq = terms.get("terms");
  if (YAML.isSeq(seq)) {
    const have = new Set((seq.toJSON() as string[]).map((t) => t.toLowerCase()));
    for (const s of x.skills) if (!have.has(s.toLowerCase())) { seq.add(s); have.add(s.toLowerCase()); }
  } else {
    terms.set("terms", [...new Set(x.skills)]);
  }

  const comp = YAML.parseDocument(current.companies || "companies: []\n");
  const found = probes.filter((p) => p.found).map((p) => ({ name: p.name, ats: p.found!.ats, token: p.found!.token, priority: "A", note: `added by setup walkthrough ${today}` }));
  if (found.length) {
    const prior = x.replaceCompanies ? [] : (((comp.get("companies") as YAML.YAMLSeq | undefined)?.toJSON() as { ats: string; token: string }[] | undefined) ?? []);
    const keys = new Set(prior.map((c) => `${c.ats}:${c.token}`));
    comp.set("companies", [...prior, ...found.filter((f) => !keys.has(`${f.ats}:${f.token}`))]);
  }

  return { target, eligibility: elig.toString({ lineWidth: 0 }), preferences: prefs.toString({ lineWidth: 0 }), techTerms: terms.toString({ lineWidth: 0 }), companies: comp.toString({ lineWidth: 0 }) };
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}${n < 400000 ? ` (about $${Math.round(n / HOURS_PER_YEAR)}/hr)` : ""}`;

export function summaryLines(x: Answers, probes: ProbeResult[]): [string, string][] {
  return [
    ["Field", x.fieldLabel],
    ["Looking for", x.roleDescription],
    ["Titles", `${x.primaryTitles.join(", ")}${x.secondaryTitles.length ? `; also ${x.secondaryTitles.join(", ")}` : ""}`],
    ["Ruled out by title", x.excludeWords.join(", ") || "nothing"],
    ["Rather not", x.avoidWork.join(", ") || "nothing"],
    [`Employer fit (${x.teamFitLabel})`, x.teamFitDescription],
    ["Skills and credentials", x.skills.join(", ") || "none listed"],
    ["Experience", `${x.years} years, targeting ${x.seniority}`],
    ["Part-time / per diem", x.partTimeOk ? "OK" : "not wanted"],
    ["Base pay", `at least ${usd(x.minBase)}, target ${usd(x.targetBase)}`],
    ["Location", `${x.home}; remote ${x.remoteOk ? "OK" : "not wanted"}; commute area: ${x.commute.join(", ") || "none"}`],
    ["Active clearance", x.hasClearance ? "yes" : "no"],
    ["Employers", probes.length ? probes.map((p) => (p.found ? `${p.name} (${p.found.ats}, ${p.found.openPostings} open${p.found.guessed ? `; matched by the short name "${p.found.token}", so check it is the right company` : ""})` : `${p.name} (no supported job board found; skipped)`)).join("; ") : "keep current list"],
  ];
}

export function summarize(x: Answers, probes: ProbeResult[]): string {
  return summaryLines(x, probes).map(([k, v]) => `${k}: ${v}`).join("\n");
}

export async function probeAll(names: string[], fetcher: Fetcher, onEach?: (r: ProbeResult) => void): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const c of names) {
    const r = await probeCompany(c, fetcher);
    onEach?.(r);
    out.push(r);
  }
  return out;
}

/** Writes all config files, keeping a dated backup of each existing one. */
export function writeConfigs(x: Answers, probes: ProbeResult[], paths = DEFAULT_PATHS(), today = new Date().toISOString().slice(0, 10)): { files: ConfigFiles; backupSuffix: string } {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const current: ConfigFiles = { target: read(paths.target), eligibility: read(paths.eligibility), preferences: read(paths.preferences), techTerms: read(paths.techTerms), companies: read(paths.companies) };
  const out = buildConfigs(x, current, probes, today);
  const backupSuffix = `.bak-${today.replace(/-/g, "")}`;
  for (const k of Object.keys(paths) as (keyof ConfigFiles)[]) {
    if (existsSync(paths[k])) copyFileSync(paths[k], `${paths[k]}${backupSuffix}`);
    writeFileSync(paths[k], out[k]);
  }
  return { files: out, backupSuffix };
}

/** Current settings as raw answers, so re-running the setup starts from what is saved. */
export function currentRawAnswers(paths = DEFAULT_PATHS()): Partial<RawAnswers> {
  const r: Partial<RawAnswers> = {};
  try {
    if (!existsSync(paths.target) || !readFileSync(paths.target, "utf8").includes("setup walkthrough")) return r;
    const t = TargetSchema.parse(YAML.parse(readFileSync(paths.target, "utf8")));
    const e = YAML.parse(readFileSync(paths.eligibility, "utf8"));
    const p = YAML.parse(readFileSync(paths.preferences, "utf8"));
    const unre = (s: string) => s.replace(/^\\b|\\b$/g, "").replace(/\\(.)/g, "$1");
    const titles = (pat: string | undefined) => (pat && pat !== "$^" ? pat.split("|").map(unre) : []);
    r.roleDescription = t.role_description;
    r.fieldLabel = t.goal_label;
    r.primaryTitles = titles(p?.target_titles?.primary?.pattern).join(", ");
    r.secondaryTitles = titles(p?.target_titles?.secondary?.pattern).join(", ");
    r.excludeWords = (e.roles?.excluded_title_patterns ?? []).map(unre).join(", ");
    r.avoidWork = (p?.deprioritized_work ?? []).map((d: { label: string }) => d.label).join(", ");
    r.teamFitDescription = t.team_fit.signal_description;
    r.teamFitLabel = t.team_fit.label;
    r.skills = t.extra_skill_synonyms.join(", ");
    r.years = String(t.experience.years);
    r.seniority = t.experience.preferred_seniority;
    r.partTimeOk = e.roles?.part_time_ok ? "y" : "n";
    r.minBase = String(e.compensation?.min_base_usd ?? "");
    r.targetBase = String(e.compensation?.target_base_usd ?? "");
    r.home = e.location?.home ?? "";
    r.remoteOk = e.location?.remote_ok === false ? "n" : "y";
    r.commute = (e.location?.dc_metro ?? []).join(", ");
    r.hasClearance = e.candidate?.has_active_clearance ? "y" : "n";
  } catch {
    return {};
  }
  return r;
}

/** Runs the full terminal walkthrough: questions, employer lookup, summary, confirmation, write with backups. */
export async function runWalkthrough(a: Asker, fetcher: Fetcher, paths = DEFAULT_PATHS(), today = new Date().toISOString().slice(0, 10)) {
  const x = await collectAnswers(a);
  let probes: ProbeResult[] = [];
  if (x.companies.length) {
    a.say("\nLooking up which job board each employer uses (Greenhouse, Lever, Ashby)...");
    probes = await probeAll(x.companies, fetcher, (r) =>
      a.say(r.found ? `   ${r.name}: ${r.found.ats} (${r.found.openPostings} open postings)${r.found.guessed ? ` [matched by short name "${r.found.token}"; check it]` : ""}` : `   ${r.name}: no supported job board found; skipped`),
    );
  }
  a.say(`\nSummary\n-------\n${summarize(x, probes)}\n`);
  if (!yes(await a.ask("Write these settings? (y/n)", "y"))) {
    a.say("Nothing was changed.");
    return { written: false as const, answers: x };
  }
  const { files, backupSuffix } = writeConfigs(x, probes, paths, today);
  a.say(`\nSaved. Backups end in ${backupSuffix}.\nNext: npm run cas -- reevaluate   (re-apply the rules), then add your experience (ONBOARDING.md step 4).`);
  return { written: true as const, answers: x, files };
}
