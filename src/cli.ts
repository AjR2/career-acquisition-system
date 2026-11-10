import { loadTarget } from "./config/target.js";
import { loadEnv } from "./config/env.js";
import { loadCompanies, loadEligibilityConfig } from "./config/files.js";
import { openDb } from "./db/index.js";
import { politeFetcher } from "./discovery/http.js";
import { discover, reevaluate } from "./run/discover.js";
import { runExclusive } from "./run/lease.js";
import { exportLabelSet } from "./run/labelset.js";
import path from "node:path";
import { PROJECT_ROOT } from "./config/env.js";
import { AnthropicLlm, spentToday } from "./llm/client.js";
import { loadClaims } from "./evidence/claims.js";
import { loadBannedConfig } from "./validate/linter.js";
import { loadTechTerms } from "./validate/claims-validator.js";
import { draftTop, dropBelowScoreFloor, loadDraftDeps, loadLlmConfig, loadPreferences, loadProfile, redraftRevisions, scorePending } from "./run/pipeline.js";
import { startServer } from "./ui/server.js";
import { writeWeeklyReport } from "./run/report.js";
import { runDaily } from "./run/daily.js";
import { loadStandardAnswers } from "./apply/plan.js";
import { createInterface } from "node:readline/promises";
import { runWalkthrough } from "./setup/walkthrough.js";

const USAGE = `Usage: npm run cas -- <command>

  migrate                     Create or upgrade the database
  discover [--only token,...] Fetch boards, normalize, dedupe, evaluate eligibility
           [--no-detail]      Skip Greenhouse per-job detail (faster, no pay/questions)
  reevaluate                  Re-run eligibility rules on undrafted postings
  stats                       Pipeline counts by state and lane
  show <id>                   Print one posting with its eligibility result and events
  companies                   Board health per company
  labelset                    Export 20 real postings for the hand-label pass
  score [--limit N] [--rescore]  Analyze (Haiku) and score eligible postings; --rescore recomputes all from stored analyses
  draft [--id N]              Draft resumes for top-scoring postings (daily cap from config/llm.yaml)
  resume <posting id>         Print the latest resume draft and its validation for a posting
  spend                       Model spend today vs the daily cap
  serve                       Start the approval UI on http://127.0.0.1:<CAS_PORT>
  report                      Write the weekly report to data/reports/
  setup-target                Guided setup: answer questions about the jobs you want; writes the config files
  daily [--force]             Scheduled run: discover -> score -> draft (+ weekly report on Sundays); skips if already ran today`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const env = loadEnv();
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(USAGE);
  if (cmd === "setup-target") {
    // Read answers as a line stream so typed and piped input both work.
    const rl = createInterface({ input: process.stdin, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    try {
      await runWalkthrough(
        {
          ask: async (q, def) => {
            process.stdout.write(def !== undefined && def !== "" ? `${q} [${def}]: ` : `${q}: `);
            const next = await lines.next();
            if (next.done) throw new Error("Input ended before the walkthrough finished. Nothing was changed.");
            const a = String(next.value).trim();
            return a === "" && def !== undefined ? def : a;
          },
          say: (t) => console.log(t),
        },
        politeFetcher({ timeoutMs: 20000, retries: 1 }),
      );
    } finally {
      rl.close();
    }
    return;
  }
  const db = openDb();
  console.error(`[cas] env=${env.CAS_ENV} db=${env.dbPath}`);

  switch (cmd) {
    case "migrate":
      console.log("migrations applied");
      break;

    case "discover": {
      const only = argValue(args, "--only")?.split(",");
      const companies = loadCompanies().filter((c) => !only || only.includes(c.token));
      const cfg = loadEligibilityConfig();
      const out = await runExclusive(db, "discover", 2 * 60 * 60 * 1000, () =>
        discover(db, companies, politeFetcher(), cfg, { greenhouseDetail: !args.includes("--no-detail") }),
      );
      console.log(JSON.stringify(out, null, 2));
      if (out.status === "failed") process.exitCode = 1;
      break;
    }

    case "reevaluate": {
      const out = await runExclusive(db, "reevaluate", 30 * 60 * 1000, async () => reevaluate(db, loadCompanies(), loadEligibilityConfig()));
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case "stats": {
      console.table(db.prepare("SELECT state, count(*) AS n FROM postings GROUP BY state ORDER BY n DESC").all());
      console.table(db.prepare("SELECT lane, count(*) AS n FROM postings WHERE state NOT IN ('CLOSED') GROUP BY lane").all());
      console.table(
        db.prepare(`SELECT p.company_name AS company, count(*) AS qualified FROM postings p WHERE p.state IN ('QUALIFIED','NEEDS_ATTENTION') GROUP BY p.company_name ORDER BY qualified DESC`).all(),
      );
      break;
    }

    case "show": {
      const id = Number(args[0]);
      const p = db.prepare("SELECT id, company_name, title, state, url, location_raw, lane, employment_type, eligibility_json, ai_policy_text FROM postings WHERE id = ?").get(id) as Record<string, string> | undefined;
      if (!p) throw new Error(`posting ${id} not found`);
      const e = p.eligibility_json ? JSON.parse(p.eligibility_json) : null;
      console.log({ ...p, eligibility_json: undefined, verdict: e?.verdict, reasons: e?.reasons, flags: e?.flags, comp: e?.comp, location: e?.location && { ...e.location, segments: e.location.segments } });
      console.table(db.prepare("SELECT at, kind, from_state, to_state, actor FROM events WHERE posting_id = ? ORDER BY id").all(id));
      break;
    }

    case "labelset": {
      const dir = path.join(PROJECT_ROOT, "fixtures", "labeled");
      const n = exportLabelSet(db, path.join(dir, "label-me.yaml"), path.join(dir, "postings.json"));
      console.log(`wrote ${n} postings to fixtures/labeled/label-me.yaml`);
      break;
    }

    case "score": {
      const cfg = loadLlmConfig();
      const out = await runExclusive(db, "score", 60 * 60 * 1000, () =>
        scorePending(db, new AnthropicLlm(db), { model: env.CAS_MODEL_CLASSIFY, weights: cfg.suitability.weights, techTerms: loadTechTerms(), claims: loadClaims(), limit: Number(argValue(args, "--limit") ?? 1000), rescore: args.includes("--rescore"), prefs: loadPreferences(), target: loadTarget(), targetBase: loadEligibilityConfig().compensation.target_base_usd }).then(
          (scored) => ({ ...scored, droppedBelowFloor: dropBelowScoreFloor(db, cfg.drafting.min_suitability).dropped }),
        ),
      );
      console.log(JSON.stringify(out, null, 2));
      console.log(`spend today: $${spentToday(db).toFixed(4)}`);
      break;
    }

    case "draft": {
      const cfg = loadLlmConfig();
      const deps = loadDraftDeps(new AnthropicLlm(db), { banned: loadBannedConfig(), techTerms: loadTechTerms(), draftModel: env.CAS_MODEL_DRAFT, reviewModel: env.CAS_MODEL_DRAFT });
      const id = argValue(args, "--id");
      const out = await runExclusive(db, "draft", 60 * 60 * 1000, async () => ({
        revisions: await redraftRevisions(db, deps),
        drafts: await draftTop(db, deps, { maxPerDay: cfg.drafting.max_per_day, minScore: id ? 0 : cfg.drafting.min_suitability, onlyId: id ? Number(id) : undefined, maxQueue: cfg.drafting.max_queue }),
      }));
      console.log(JSON.stringify(out, null, 2));
      console.log(`spend today: $${spentToday(db).toFixed(4)}`);
      break;
    }

    case "resume": {
      const m = db.prepare("SELECT version, status, rendered_md, validation_json FROM materials WHERE posting_id = ? AND kind = 'resume' ORDER BY version DESC LIMIT 1").get(Number(args[0])) as
        | { version: number; status: string; rendered_md: string; validation_json: string }
        | undefined;
      if (!m) throw new Error("no resume draft for that posting");
      console.log(m.rendered_md);
      const v = JSON.parse(m.validation_json);
      console.log(`\n--- version ${m.version}, ${m.status}; claim issues ${v.claimIssues.length}, lint ${v.lint.length}, voice ${v.voice?.verdict ?? "n/a"}`);
      for (const i of v.voice?.issues ?? []) console.log(`  voice ${i.severity}: "${i.quote}" -> ${i.fix}`);
      for (const i of v.claimIssues) console.log(`  claim: ${i.problem}: ${i.detail}`);
      break;
    }

    case "spend": {
      const cap = env.CAS_DAILY_SPEND_CAP_USD;
      console.log(`today: $${spentToday(db).toFixed(4)} of $${cap.toFixed(2)} cap`);
      console.table(db.prepare("SELECT purpose, model, count(*) AS calls, round(sum(cost_usd), 4) AS usd FROM llm_calls WHERE local_date = date('now','localtime') GROUP BY purpose, model").all());
      break;
    }

    case "serve": {
      const ctx = () => ({ claims: loadClaims(), banned: loadBannedConfig(), techTerms: loadTechTerms(), profile: loadProfile(), answers: loadStandardAnswers() });
      startServer({ db, ctx }, env.CAS_PORT);
      console.log(`CAS approval UI: http://127.0.0.1:${env.CAS_PORT}  (Ctrl+C to stop)`);
      await new Promise(() => undefined);
      break;
    }

    case "report":
      console.log(`wrote ${writeWeeklyReport(db)}`);
      break;

    case "daily": {
      const out = await runDaily(db, { force: args.includes("--force") });
      console.log(JSON.stringify(out, null, 2));
      if (out.status === "failed") process.exitCode = 1;
      break;
    }

    case "companies":
      console.table(db.prepare("SELECT name, ats, token, last_fetch_status AS status, last_error AS error, (SELECT count(*) FROM postings p WHERE p.company_id = c.id AND p.closed_at IS NULL) AS open FROM companies c ORDER BY name").all());
      break;

    default:
      console.log(USAGE);
      process.exitCode = 2;
  }
  db.close();
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
