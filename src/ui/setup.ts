import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { loadEnv, PROJECT_ROOT, resetEnvCache } from "../config/env.js";
import { loadCompanies } from "../config/files.js";
import type { DB } from "../db/index.js";
import type { Fetcher } from "../discovery/types.js";
import { loadClaims, type Claim } from "../evidence/claims.js";
import { AnthropicLlm, type LlmClient } from "../llm/client.js";
import { log } from "../log.js";
import { runDaily } from "../run/daily.js";
import { lastSuccessfulRun } from "../run/lease.js";
import { addConfirmedClaim, ClaimEditError, confirmClaim, deleteClaim, suggestFromResume } from "../setup/claims-edit.js";
import type { ProbeResult } from "../setup/companies.js";
import { currentRawAnswers, DEFAULT_PATHS, type ConfigFiles, parseAnswers, probeAll, QUESTIONS, SetupError, summaryLines, writeConfigs, type RawAnswers } from "../setup/walkthrough.js";
import { esc, page } from "./html.js";

const MIN_CLAIMS = 5;

/** Every file the setup pages read or write. Tests point these at a temp folder. */
export type SetupFiles = ConfigFiles & { env: string; profile: string; answers: string; claims: string };
export const defaultSetupFiles = (root = PROJECT_ROOT): SetupFiles => ({
  ...DEFAULT_PATHS(root),
  env: path.join(root, ".env"),
  profile: path.join(root, "config", "profile.local.yaml"),
  answers: path.join(root, "config", "standard-answers.yaml"),
  claims: path.join(root, "career-evidence", "approved-claims.yaml"),
});
const configPaths = (F: SetupFiles): ConfigFiles => ({ target: F.target, eligibility: F.eligibility, preferences: F.preferences, techTerms: F.techTerms, companies: F.companies });

export interface SetupDeps {
  db: DB;
  fetcher: Fetcher;
  form: (action: string, inner: string, label: string, cls?: string) => string;
  /** Tests inject a fake model client and skip launchd. */
  llm?: () => LlmClient;
  installSchedule?: () => Promise<string>;
  files?: SetupFiles;
}

type Result = { html: string; code?: number } | { redirect: string };

const readYaml = (f: string) => (existsSync(f) ? (YAML.parse(readFileSync(f, "utf8")) ?? {}) : {});
const safeClaims = (file: string): Claim[] => {
  try {
    return existsSync(file) ? loadClaims(file) : [];
  } catch {
    return [];
  }
};

function launchdLabel(envFile: string): string {
  const fromEnv = existsSync(envFile) ? readFileSync(envFile, "utf8").match(/^CAS_LAUNCHD_LABEL=(.+)$/m)?.[1] : undefined;
  return process.env.CAS_LAUNCHD_LABEL ?? fromEnv ?? `com.cas.daily.${os.userInfo().username}`;
}

/** Setup progress shown on the Get started page. */
export function setupStatus(db: DB, F: SetupFiles = defaultSetupFiles()) {
  const key = /^sk-ant-/.test(process.env.ANTHROPIC_API_KEY ?? "");
  const targetText = existsSync(F.target) ? readFileSync(F.target, "utf8") : "";
  const profile = readYaml(F.profile) as { name?: string };
  const answers = readYaml(F.answers) as Record<string, { status?: string }>;
  const claims = safeClaims(F.claims);
  let companies = 0;
  try {
    companies = loadCompanies(F.companies).length;
  } catch {
    companies = 0;
  }
  return {
    key,
    target: targetText.includes("setup walkthrough"),
    profile: !!profile.name && profile.name !== "Your Name",
    answersConfirmed: Object.values(answers).filter((a) => a?.status === "USER_CONFIRMED").length,
    answersTotal: Object.values(answers).filter((a) => a && typeof a === "object" && "status" in a).length,
    confirmedClaims: claims.filter((c) => c.status === "USER_CONFIRMED" || c.status === "VERIFIED").length,
    suggestedClaims: claims.filter((c) => c.status === "UNVERIFIED").length,
    companies,
    lastRun: lastSuccessfulRun(db, "daily"),
    scheduled: existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `${launchdLabel(F.env)}.plist`)),
  };
}

export function makeSetupPages(deps: SetupDeps) {
  const { db, form } = deps;
  const F = deps.files ?? defaultSetupFiles();
  const run: { running: boolean; startedAt?: string; result?: string; error?: string } = { running: false };
  const llm = () => deps.llm?.() ?? new AnthropicLlm(db);

  function home(flash = ""): string {
    const s = setupStatus(db, F);
    const step = (done: boolean, n: number, title: string, detail: string, action: string) =>
      `<li class="card ${done ? "done" : ""}"><span class="dot">${done ? "✓" : n}</span><div style="flex:1"><b>${esc(title)}</b><div class="muted">${detail}</div><div style="margin-top:6px">${action}</div></div></li>`;
    const runBox = run.running
      ? `<p class="warn">Finding jobs now (started ${esc(run.startedAt?.slice(11, 16))}). This takes 5 to 20 minutes. This page refreshes by itself.</p>`
      : run.error
        ? `<p class="bad">Last run failed: ${esc(run.error)}</p>`
        : run.result
          ? `<p class="good">${esc(run.result)}</p>`
          : "";
    const ready = s.key && s.target && s.profile && s.confirmedClaims >= MIN_CLAIMS;
    const body = `${flash}<h1>Get started</h1>
      <p>Work through these steps from top to bottom. Nothing is ever sent to an employer without you: CAS prepares each application, and you review it and click submit yourself.</p>
      <ol class="steps">
      ${step(s.key, 1, "Connect the AI service", s.key ? "Your Anthropic API key is saved." : "CAS uses Claude to read job postings and draft resumes. You need an Anthropic API key (about $1 a week).", `<a href="/start/key">${s.key ? "Change key" : "Add key"}</a>`)}
      ${step(s.target, 2, "Describe the jobs you want", s.target ? "Saved. You can change it any time." : "About 20 short questions: titles, pay, location, and employers.", `<a href="/start/target">${s.target ? "Review or change" : "Start"}</a>`)}
      ${step(s.profile && s.answersConfirmed > 0, 3, "Your contact details and standard answers", `${s.profile ? "Contact details saved." : "Name, email, and phone for your resume and applications."} ${s.answersConfirmed}/${s.answersTotal} standard answers approved.`, `<a href="/start/profile">${s.profile ? "Review" : "Fill in"}</a>`)}
      ${step(s.confirmedClaims >= MIN_CLAIMS, 4, "Your experience", `${s.confirmedClaims} confirmed${s.suggestedClaims ? `, ${s.suggestedClaims} waiting for you to check` : ""}. Resumes use only facts you confirm; drafting starts at ${MIN_CLAIMS}.`, `<a href="/start/claims">${s.confirmedClaims ? "Review and add" : "Add your experience"}</a>`)}
      ${step(!!s.lastRun, 5, "Find jobs", `${s.companies} employers on your list. ${s.lastRun ? `Last search finished ${esc(s.lastRun.slice(0, 16).replace("T", " "))}.` : "No search yet."}${ready ? "" : " Finish steps 1 to 4 first for drafted resumes (searching works after steps 1 and 2)."}`, `${runBox}${run.running ? "" : form("/start/run", "", "Find jobs now", "primary")}`)}
      ${step(s.scheduled, 6, "Search automatically every morning", s.scheduled ? "On. CAS searches at 6:30 each morning (or when you next log in) while this Mac is on." : "Optional. CAS searches at 6:30 each morning while your Mac is on.", s.scheduled ? "" : form("/start/schedule", "", "Turn on daily search"))}
      ${step(false, 7, "Review applications", "Each morning, open the Queue. For each job: read the tailored resume, then Approve, Reject, or ask for changes. After approving, CAS opens the form in a browser and fills it in; you check it and click submit.", `<a href="/">Open the Queue</a>`)}
      </ol>
      <p class="muted">To stop CAS, close the Terminal window that opened with it. To start again, double-click "Start CAS".</p>`;
    return page("Get started", body, run.running ? `<meta http-equiv="refresh" content="15">` : "");
  }

  function keyPage(flash = ""): string {
    return page(
      "API key",
      `${flash}<h1>Connect the AI service</h1>
      <div class="card"><p>1. Go to <b>console.anthropic.com</b> and sign in (or create an account).<br>
      2. Under <b>Settings → Billing</b>, add a payment method and a small credit (for example $10).<br>
      3. Under <b>Settings → Limits</b>, set a monthly spend limit (for example $10) so costs can never surprise you.<br>
      4. Under <b>API keys</b>, click <b>Create key</b>, copy it, and paste it below.</p>
      <p class="muted">The key is saved only on this computer, in the <code>.env</code> file. CAS also stops itself at $${loadEnv().CAS_DAILY_SPEND_CAP_USD} of AI use per day.</p>
      ${form("/start/key", `<label>API key<input type="password" name="key" autocomplete="off" placeholder="sk-ant-..." required></label>`, "Save key", "primary")}</div>
      <p><a href="/start">Back</a></p>`,
    );
  }

  function saveKey(key: string): Result {
    const k = key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return { html: keyPage(`<div class="card bad">That does not look like an Anthropic API key. It should start with sk-ant- and have no spaces.</div>`), code: 400 };
    const cur = existsSync(F.env) ? readFileSync(F.env, "utf8") : "";
    const next = /^ANTHROPIC_API_KEY=.*$/m.test(cur) ? cur.replace(/^ANTHROPIC_API_KEY=.*$/m, `ANTHROPIC_API_KEY=${k}`) : `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}ANTHROPIC_API_KEY=${k}\n`;
    writeFileSync(F.env, next);
    chmodSync(F.env, 0o600);
    process.env.ANTHROPIC_API_KEY = k;
    resetEnvCache();
    log.info("API key updated from the setup page");
    return { redirect: "/start" };
  }

  function targetForm(values: Partial<RawAnswers>, flash = ""): string {
    const field = (q: (typeof QUESTIONS)[number]) => {
      const v = values[q.key] ?? q.def?.(values) ?? "";
      const hint = q.example ? `<span class="hint">Example: ${esc(q.example)}</span>` : "";
      const label = esc(q.text.replace(/ \(y\/n[^)]*\)/, ""));
      let input: string;
      if (q.kind === "yesno") input = `<select name="${q.key}"><option value="y"${/^y/i.test(v) ? " selected" : ""}>Yes</option><option value="n"${/^y/i.test(v) ? "" : " selected"}>No</option></select>`;
      else if (q.kind === "choice") input = `<select name="${q.key}">${q.choices!.map((c) => `<option${c === v ? " selected" : ""}>${c}</option>`).join("")}</select>`;
      else if (q.kind === "long") input = `<textarea name="${q.key}" rows="2"${q.required ? " required" : ""}>${esc(v)}</textarea>`;
      else input = `<input type="text" name="${q.key}" value="${esc(v)}"${q.required ? " required" : ""}>`;
      return `<label><b>${label}</b>${hint}${input}</label>`;
    };
    return page(
      "Jobs you want",
      `${flash}<h1>Describe the jobs you want</h1><p class="muted">Answer what you can; the rest has sensible defaults. You will see a summary before anything is saved.</p>
      <div class="card">${form("/start/target", QUESTIONS.map(field).join(""), "Next: check employers and review", "primary big")}</div><p><a href="/start">Back</a></p>`,
    );
  }

  const ProbesSchema = z.array(z.object({ name: z.string(), tried: z.array(z.string()), found: z.object({ ats: z.enum(["greenhouse", "lever", "ashby"]), token: z.string().regex(/^[A-Za-z0-9._-]+$/), openPostings: z.number(), guessed: z.boolean().optional() }).nullable() }));

  async function reviewTarget(f: URLSearchParams): Promise<Result> {
    const raw = Object.fromEntries(QUESTIONS.map((q) => [q.key, f.get(q.key) ?? ""])) as RawAnswers;
    let x;
    try {
      x = parseAnswers(raw);
    } catch (e) {
      if (e instanceof SetupError) return { html: targetForm(raw, `<div class="card bad"><b>Please fix:</b><pre>${esc(e.message)}</pre></div>`), code: 400 };
      throw e;
    }
    const probes = x.companies.length ? await probeAll(x.companies.slice(0, 60), deps.fetcher) : [];
    const hidden = QUESTIONS.map((q) => `<input type="hidden" name="${q.key}" value="${esc(raw[q.key])}">`).join("") + `<input type="hidden" name="probes" value="${esc(JSON.stringify(probes))}">`;
    const rows = summaryLines(x, probes).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("");
    return {
      html: page(
        "Review",
        `<h1>Review your settings</h1><div class="card"><table>${rows}</table></div>
        ${probes.some((p) => !p.found) ? `<p class="warn">Employers marked "no supported job board" post jobs somewhere CAS cannot read (often Workday or iCIMS). They were left out.</p>` : ""}
        ${form("/start/target/save", hidden, "Save these settings", "primary big")} ${form("/start/target/edit", hidden.replace(/<input type="hidden" name="probes"[^>]*>/, ""), "Go back and change")}`,
      ),
    };
  }

  function saveTarget(f: URLSearchParams): Result {
    const raw = Object.fromEntries(QUESTIONS.map((q) => [q.key, f.get(q.key) ?? ""])) as RawAnswers;
    const x = parseAnswers(raw);
    const probes = ProbesSchema.parse(JSON.parse(f.get("probes") || "[]")) as ProbeResult[];
    writeConfigs(x, probes, configPaths(F));
    return { html: page("Saved", `<h1>Saved</h1><p class="good">Your job settings are saved (backups were kept).</p><p><a href="/start">Back to Get started</a></p>`) };
  }

  function profilePage(flash = ""): string {
    const p = readYaml(F.profile) as Record<string, string>;
    const a = readYaml(F.answers) as Record<string, { question?: string; answer?: unknown; status?: string }>;
    const prof = ["name", "location", "email", "phone", "linkedin"]
      .map((k) => `<label><b>${k === "linkedin" ? "LinkedIn URL (optional)" : k.charAt(0).toUpperCase() + k.slice(1)}</b><input type="text" name="p_${k}" value="${esc(p[k] && !/^(Your Name|City, ST|you@example\.com|\(000\) 000-0000|https:\/\/www\.linkedin\.com\/in\/you\/)$/.test(p[k]) ? p[k] : "")}"${k === "linkedin" ? "" : " required"}></label>`)
      .join("");
    const qs = Object.entries(a)
      .filter(([, v]) => v && typeof v === "object" && "question" in v && "status" in v)
      .map(([k, v]) => `<div class="card"><label><b>${esc(v.question)}</b><input type="text" name="a_${esc(k)}" value="${esc(v.answer ?? "")}"></label>
        <label><input type="checkbox" name="ok_${esc(k)}"${v.status === "USER_CONFIRMED" ? " checked" : ""}> CAS may fill this answer in for me</label></div>`)
      .join("");
    return page(
      "Your details",
      `${flash}<h1>Your contact details and standard answers</h1>
      ${form("/start/profile", `<div class="card"><h3>Contact details</h3><p class="muted">Used for your resume header and application forms. Saved only on this computer.</p>${prof}</div>
        <h3>Standard answers</h3><p class="muted">Questions many applications ask. Only answers you tick are ever filled in; anything else waits for you. CAS never answers demographic (EEO) questions.</p>${qs}`, "Save", "primary big")}
      <p><a href="/start">Back</a></p>`,
    );
  }

  function saveProfile(f: URLSearchParams): Result {
    const v = (k: string) => (f.get(`p_${k}`) ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!v("name") || !v("email")) return { html: profilePage(`<div class="card bad">Name and email are required.</div>`), code: 400 };
    const pdoc = existsSync(F.profile) ? YAML.parseDocument(readFileSync(F.profile, "utf8")) : YAML.parseDocument("{}");
    for (const k of ["name", "location", "email", "phone", "linkedin"]) pdoc.set(k, v(k));
    if (!pdoc.has("github")) pdoc.set("github", "");
    writeFileSync(F.profile, pdoc.toString({ lineWidth: 0 }));
    if (existsSync(F.answers)) {
      const adoc = YAML.parseDocument(readFileSync(F.answers, "utf8"));
      const cur = (adoc.toJSON() ?? {}) as Record<string, { status?: string }>;
      for (const [k, item] of Object.entries(cur)) {
        if (!item || typeof item !== "object" || !("status" in item) || !f.has(`a_${k}`)) continue;
        adoc.setIn([k, "answer"], (f.get(`a_${k}`) ?? "").trim().slice(0, 500));
        adoc.setIn([k, "status"], f.get(`ok_${k}`) ? "USER_CONFIRMED" : "PENDING");
      }
      writeFileSync(F.answers, adoc.toString({ lineWidth: 0 }));
    }
    return { redirect: "/start" };
  }

  function claimsPage(flash = ""): string {
    const claims = safeClaims(F.claims).filter((c) => c.status !== "PROHIBITED");
    const suggested = claims.filter((c) => c.status === "UNVERIFIED");
    const confirmed = claims.filter((c) => c.status === "USER_CONFIRMED" || c.status === "VERIFIED");
    const sugg = suggested
      .map((c) => `<div class="card"><p class="muted" style="font-size:13px">${esc(c.evidence)}</p>
        ${form(`/start/claims/confirm`, `<input type="hidden" name="id" value="${esc(c.id)}"><textarea name="text" rows="2">${esc(c.claim_text)}</textarea>`, "Correct: use this", "primary")}
        ${form(`/start/claims/delete`, `<input type="hidden" name="id" value="${esc(c.id)}">`, "Not right: delete")}</div>`)
      .join("");
    const conf = confirmed
      .map((c) => `<tr><td>${esc(c.claim_text)}</td><td class="muted">${esc(c.dates)}</td><td>${form(`/start/claims/delete`, `<input type="hidden" name="id" value="${esc(c.id)}">`, "Delete")}</td></tr>`)
      .join("");
    return page(
      "Your experience",
      `${flash}<h1>Your experience</h1>
      <p>Every fact in a drafted resume must come from this list, including every number, license, and tool. CAS never invents anything. Drafting starts once you have ${MIN_CLAIMS} confirmed items.</p>
      <div class="card"><h3>Fastest way: paste your resume</h3><p class="muted">CAS turns it into short statements. You then check each one: keep it, fix the wording, or delete it. Nothing is used until you confirm it.</p>
        ${form("/start/claims/resume", `<textarea name="resume" rows="8" placeholder="Paste your resume text here" required></textarea>`, "Suggest statements from my resume", "primary")}</div>
      ${suggested.length ? `<h2>Check these (${suggested.length})</h2>${sugg}` : ""}
      <div class="card"><h3>Add one yourself</h3>${form(
        "/start/claims/add",
        `<label><b>What you did</b><span class="hint">One fact per entry. Example: "Worked as a registered nurse on a 30-bed medical-surgical unit at Mercy Hospital."</span><textarea name="text" rows="2" required></textarea></label>
         <label><b>When</b><span class="hint">Example: 2019 to 2024</span><input type="text" name="dates"></label>
         <label><b>Where this is shown (optional)</b><span class="hint">Example: on my resume; license number on file</span><input type="text" name="evidence"></label>`,
        "Add",
      )}</div>
      <h2>Confirmed (${confirmed.length})</h2>${confirmed.length ? `<div class="card"><table>${conf}</table></div>` : "<p class='muted'>None yet.</p>"}
      <p><a href="/start">Back</a></p>`,
    );
  }

  async function claimsAction(action: string, f: URLSearchParams): Promise<Result> {
    try {
      if (action === "add") addConfirmedClaim({ text: f.get("text") ?? "", dates: f.get("dates") ?? "", evidence: f.get("evidence") ?? "" }, F.claims);
      else if (action === "confirm") confirmClaim(f.get("id") ?? "", f.get("text"), F.claims);
      else if (action === "delete") deleteClaim(f.get("id") ?? "", F.claims);
      else if (action === "resume") {
        if (!/^sk-ant-/.test(process.env.ANTHROPIC_API_KEY ?? "") && !deps.llm) throw new ClaimEditError("Add your API key first (step 1).");
        const n = await suggestFromResume(llm(), loadEnv().CAS_MODEL_DRAFT, f.get("resume") ?? "", F.claims);
        return { html: claimsPage(`<div class="card good">${n} statements suggested. Check each one below.</div>`) };
      }
    } catch (e) {
      if (e instanceof ClaimEditError) return { html: claimsPage(`<div class="card bad">${esc(e.message)}</div>`), code: 400 };
      throw e;
    }
    return { redirect: "/start/claims" };
  }

  function startRun(): Result {
    const s = setupStatus(db, F);
    if (!s.key) return { html: home(`<div class="card bad">Add your API key first (step 1).</div>`), code: 400 };
    if (!s.target) return { html: home(`<div class="card bad">Describe the jobs you want first (step 2).</div>`), code: 400 };
    if (run.running) return { redirect: "/start" };
    Object.assign(run, { running: true, startedAt: new Date().toISOString(), result: undefined, error: undefined });
    runDaily(db, { force: true })
      .then((out) => {
        if (out.status === "skipped") run.result = `Skipped: ${"reason" in out ? out.reason : out.error}`;
        else if (out.status === "failed") run.error = String((out as { error?: string }).error ?? "see data/logs");
        else {
          const r = out.result as { discovered: { listed: number; qualified: number }; drafted: unknown[] } | undefined;
          run.result = r ? `Done. Looked at ${r.discovered.listed} postings; ${r.discovered.qualified} new ones passed your rules; ${r.drafted.length} resume(s) drafted. Open the Queue to review.` : "Done. Open the Queue to review.";
        }
      })
      .catch((e) => (run.error = (e as Error).message))
      .finally(() => (run.running = false));
    return { redirect: "/start" };
  }

  async function schedule(): Promise<Result> {
    if (process.platform !== "darwin") return { html: home(`<div class="card bad">Daily search is set up only on a Mac.</div>`), code: 400 };
    const install =
      deps.installSchedule ??
      (() =>
        new Promise<string>((resolve, reject) =>
          execFile(path.join(PROJECT_ROOT, "scripts", "install-launchd.sh"), { cwd: PROJECT_ROOT }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
        ));
    try {
      await install();
    } catch (e) {
      return { html: home(`<div class="card bad">Could not turn on daily search: ${esc((e as Error).message)}</div>`), code: 500 };
    }
    return { redirect: "/start" };
  }

  return {
    /** Returns a page for GET paths under /start, or null if not a setup path. */
    get(pathname: string): string | null {
      if (pathname === "/start") return home();
      if (pathname === "/start/key") return keyPage();
      if (pathname === "/start/target") return targetForm(currentRawAnswers(configPaths(F)));
      if (pathname === "/start/profile") return profilePage();
      if (pathname === "/start/claims") return claimsPage();
      return null;
    },
    async post(pathname: string, f: URLSearchParams): Promise<Result | null> {
      if (pathname === "/start/key") return saveKey(f.get("key") ?? "");
      if (pathname === "/start/target") return reviewTarget(f);
      if (pathname === "/start/target/edit") return { html: targetForm(Object.fromEntries(QUESTIONS.map((q) => [q.key, f.get(q.key) ?? ""]))) };
      if (pathname === "/start/target/save") return saveTarget(f);
      if (pathname === "/start/profile") return saveProfile(f);
      const m = pathname.match(/^\/start\/claims\/(add|confirm|delete|resume)$/);
      if (m) return claimsAction(m[1]!, f);
      if (pathname === "/start/run") return startRun();
      if (pathname === "/start/schedule") return schedule();
      return null;
    },
    status: () => setupStatus(db, F),
  };
}
