import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
export const PROD_DB_PATH = path.join(PROJECT_ROOT, "data", "cas.db");

const EnvSchema = z.object({
  CAS_ENV: z.enum(["dev", "test", "prod"]).default("dev"),
  CAS_DB_PATH: z.string().optional(),
  CAS_PORT: z.coerce.number().int().default(4780),
  ANTHROPIC_API_KEY: z.string().optional(),
  CAS_MODEL_CLASSIFY: z.string().default("claude-haiku-5-5"),
  CAS_MODEL_DRAFT: z.string().default("claude-sonnet-5-5"),
  CAS_DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(3),
  CAS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof EnvSchema> & { dbPath: string };

let cached: Env | undefined;

/** Loads .env (if present and not under test) and validates the environment. */
export function loadEnv(): Env {
  if (cached) return cached;
  const envFile = path.join(PROJECT_ROOT, ".env");
  if (!process.env.VITEST && existsSync(envFile)) process.loadEnvFile(envFile);
  const parsed = EnvSchema.parse(process.env);
  const dbPath = resolveDbPath(parsed.CAS_ENV, parsed.CAS_DB_PATH);
  cached = { ...parsed, dbPath };
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

function resolveDbPath(env: Env["CAS_ENV"], configured?: string): string {
  if (configured === ":memory:") return configured;
  if (configured) return path.resolve(PROJECT_ROOT, configured);
  if (env === "test") return ":memory:";
  if (env === "dev") return path.join(PROJECT_ROOT, "data", "cas-dev.db");
  return PROD_DB_PATH;
}

/**
 * Refuses to run tests against the production database.
 * Called by openDb() and by the test setup file.
 */
export function assertDbAllowed(env: Pick<Env, "CAS_ENV">, dbPath: string): void {
  if (dbPath === ":memory:") return;
  const resolved = path.resolve(dbPath);
  const isProdDb = resolved === PROD_DB_PATH || path.basename(resolved) === "cas.db";
  const underTest = Boolean(process.env.VITEST) || env.CAS_ENV === "test";
  if (underTest && isProdDb) throw new Error(`Refusing to use production database under test: ${resolved}`);
  // Only CAS_ENV=prod may open the production database (incident 2026-10-22).
  if (isProdDb && env.CAS_ENV !== "prod") throw new Error(`Refusing to open production database with CAS_ENV=${env.CAS_ENV}: ${resolved}`);
}
