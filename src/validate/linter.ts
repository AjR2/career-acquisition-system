import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROJECT_ROOT } from "../config/env.js";

export interface BannedConfig {
  phrases: string[];
  characters: string[];
}

export interface LintViolation {
  rule: "banned_phrase" | "banned_character";
  match: string;
  index: number;
  context: string;
}

export function loadBannedConfig(file = path.join(PROJECT_ROOT, "config", "banned-phrases.yaml")): BannedConfig {
  return z.object({ phrases: z.array(z.string()), characters: z.array(z.string()) }).parse(YAML.parse(readFileSync(file, "utf8")));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Deterministic banned-phrase linter. Any violation fails the document. */
export function lint(text: string, cfg: BannedConfig): LintViolation[] {
  const out: LintViolation[] = [];
  const ctx = (i: number, len: number) => text.slice(Math.max(0, i - 30), i + len + 30).replace(/\s+/g, " ");
  for (const p of cfg.phrases) {
    // Word boundaries on both ends, flexible whitespace and apostrophes inside the phrase.
    const body = esc(p).replace(/\\?'/g, "['’]").replace(/\s+/g, "\\s+");
    const re = new RegExp(`(?<![\\w-])${body}(?![\\w-])`, "gi");
    for (const m of text.matchAll(re)) out.push({ rule: "banned_phrase", match: m[0], index: m.index!, context: ctx(m.index!, m[0].length) });
  }
  for (const ch of cfg.characters) {
    let i = text.indexOf(ch);
    while (i !== -1) {
      out.push({ rule: "banned_character", match: ch, index: i, context: ctx(i, ch.length) });
      i = text.indexOf(ch, i + ch.length);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}
