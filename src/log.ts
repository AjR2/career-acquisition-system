import pino from "pino";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const API_KEY = /sk-ant-[A-Za-z0-9_-]{8,}/g;

/** Redacts emails, phone numbers, and API keys from free text. */
export function redactText(s: string): string {
  return s.replace(API_KEY, "[REDACTED_KEY]").replace(EMAIL, "[REDACTED_EMAIL]").replace(PHONE, "[REDACTED_PHONE]");
}

function redactDeep(v: unknown, depth = 0): unknown {
  if (depth > 6) return v;
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === "object" && !(v instanceof Error)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, depth + 1)]));
  }
  return v;
}

export const log = pino({
  level: process.env.CAS_LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
  base: { app: "cas" },
  redact: {
    paths: ["apiKey", "*.apiKey", "headers.authorization", "*.headers.authorization", "ANTHROPIC_API_KEY", "*.ANTHROPIC_API_KEY"],
    censor: "[REDACTED]",
  },
  formatters: {
    log: (obj) => redactDeep(obj) as Record<string, unknown>,
  },
});
