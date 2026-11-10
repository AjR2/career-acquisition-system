import { loadTarget } from "../config/target.js";
import { loadEnv } from "../config/env.js";
import { loadCompanies, loadEligibilityConfig } from "../config/files.js";
import type { DB } from "../db/index.js";
import { politeFetcher } from "../discovery/http.js";
import { loadClaims } from "../evidence/claims.js";
import { AnthropicLlm, localDate, spentToday } from "../llm/client.js";
import { loadTechTerms } from "../validate/claims-validator.js";
import { loadBannedConfig } from "../validate/linter.js";
import { discover } from "./discover.js";
import { lastSuccessfulRun, runExclusive } from "./lease.js";
import { draftTop, dropBelowScoreFloor, loadDraftDeps, loadLlmConfig, loadPreferences, redraftRevisions, scorePending } from "./pipeline.js";
import { writeWeeklyReport } from "./report.js";

/**
 * The scheduled job. launchd fires it at a set time and at login; it catches up after sleep or
 * downtime by checking the last successful run in the database, and the run lease prevents overlap.
 */
export async function runDaily(db: DB, opts: { force?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const last = lastSuccessfulRun(db, "daily");
  if (!opts.force && last && localDate(new Date(last)) === localDate(now)) {
    return { status: "skipped" as const, reason: `already ran today (${last})` };
  }
  const env = loadEnv();
  return runExclusive(db, "daily", 3 * 60 * 60 * 1000, async () => {
    const cfg = loadLlmConfig();
    const claims = loadClaims();
    const techTerms = loadTechTerms();
    const llm = new AnthropicLlm(db);
    const discovered = await discover(db, loadCompanies(), politeFetcher(), loadEligibilityConfig());
    const scored = await scorePending(db, llm, { model: env.CAS_MODEL_CLASSIFY, weights: cfg.suitability.weights, techTerms, claims, prefs: loadPreferences(), target: loadTarget(), targetBase: loadEligibilityConfig().compensation.target_base_usd });
    const belowFloor = dropBelowScoreFloor(db, cfg.drafting.min_suitability);
    const deps = loadDraftDeps(llm, { banned: loadBannedConfig(), techTerms, draftModel: env.CAS_MODEL_DRAFT, reviewModel: env.CAS_MODEL_DRAFT });
    const revisions = await redraftRevisions(db, deps);
    const drafted = await draftTop(db, deps, { maxPerDay: cfg.drafting.max_per_day, minScore: cfg.drafting.min_suitability, maxQueue: cfg.drafting.max_queue });
    const report = now.getDay() === 0 ? writeWeeklyReport(db, now) : null;
    return {
      discovered: { listed: discovered.listed, new: discovered.newPostings, qualified: discovered.qualified, boardFailures: discovered.boardFailures.map((b) => b.company) },
      scored,
      droppedBelowFloor: belowFloor.dropped.length,
      revisions: revisions.results.length,
      drafted: drafted.results,
      report,
      spendToday: Number(spentToday(db).toFixed(4)),
    };
  });
}
