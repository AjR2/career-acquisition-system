import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROJECT_ROOT } from "../config/env.js";
import { isUsable, type Claim, type DocUse } from "../evidence/claims.js";

/**
 * Every sentence or bullet in a draft is a Block. A "fact" block states something about the
 * candidate and must cite approved claims. A "framing" block (e.g. why this role) may not state
 * facts: no numbers, no technologies outside the posting, no accomplishment verbs.
 */
export interface Block {
  text: string;
  kind: "fact" | "framing";
  claim_ids: string[];
}

export interface ClaimIssue {
  block: string;
  problem:
    | "fact_without_claim"
    | "unknown_claim"
    | "claim_not_usable"
    | "number_not_in_claims"
    | "tech_not_in_claims"
    | "framing_states_fact"
    | "prohibited_statement";
  detail: string;
}

export function loadTechTerms(file = path.join(PROJECT_ROOT, "config", "tech-terms.yaml")): string[] {
  return z.object({ terms: z.array(z.string()) }).parse(YAML.parse(readFileSync(file, "utf8"))).terms;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Terms written with capitals match case-sensitively ("Go" is not "go"); lowercase terms match any case. */
function termRegex(term: string): RegExp {
  const caseSensitive = term !== term.toLowerCase();
  return new RegExp(`(?<![\\w.#+-])${esc(term)}(?![\\w#+]|\\.\\w)`, caseSensitive ? "g" : "gi");
}

// Spellings of the same technology count as one ("Node.js" is supported by a claim that says "Node").
const ALIASES: Record<string, string> = { "Node.js": "Node", PostgreSQL: "Postgres", Golang: "Go", "GPT-4": "OpenAI" };

export function findTerms(text: string, terms: string[]): string[] {
  return [...new Set(terms.filter((t) => termRegex(t).test(text)).map((t) => ALIASES[t] ?? t))];
}

/** Numbers as written, normalized: "6,341" -> "6341", "$150K" -> "150k". Years and counts alike. */
export function findNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?\s?[kK]?\+?/g)) {
    const n = m[0].replace(/,/g, "").replace(/\s/g, "").replace(/\+$/, "").toLowerCase();
    if (n) out.push(n);
  }
  return out;
}

const NUMBER_WORDS: Record<string, string> = { two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12" };
function numbersIn(text: string): Set<string> {
  const s = new Set(findNumbers(text));
  for (const [w, d] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${w}\\b`, "i").test(text)) s.add(d);
  return s;
}

const ACCOMPLISHMENT = /\b(built|build|led|lead|managed|shipped|designed|created|developed|launched|delivered|grew|increased|reduced|cut|founded|published|taught|wrote|architected|implemented|owned|ran|scaled|automated|directed|specified)\b/i;
const PROHIBITED = /\b(hand[- ]?wrote|hand[- ]?coded|hand[- ]?written|wrote (?:all|every line of) the code|coded (?:it )?(?:all )?(?:by hand|myself))\b/i;

export function validateClaims(
  blocks: Block[],
  claims: Claim[],
  use: DocUse,
  ctx: { techTerms: string[]; postingText: string },
): ClaimIssue[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const issues: ClaimIssue[] = [];
  const postingTerms = new Set(findTerms(ctx.postingText, ctx.techTerms));

  for (const b of blocks) {
    const text = b.text.trim();
    if (!text) continue;
    if (PROHIBITED.test(text)) issues.push({ block: text, problem: "prohibited_statement", detail: "claims hand-written code (prohibited)" });

    if (b.kind === "framing") {
      if (findNumbers(text).length) issues.push({ block: text, problem: "framing_states_fact", detail: "framing sentence contains a number" });
      if (ACCOMPLISHMENT.test(text)) issues.push({ block: text, problem: "framing_states_fact", detail: `framing sentence uses accomplishment verb "${text.match(ACCOMPLISHMENT)![0]}"` });
      for (const t of findTerms(text, ctx.techTerms)) {
        if (!postingTerms.has(t)) issues.push({ block: text, problem: "framing_states_fact", detail: `framing sentence names ${t}, which is not in the posting` });
      }
      continue;
    }

    if (!b.claim_ids.length) {
      issues.push({ block: text, problem: "fact_without_claim", detail: "factual statement cites no claim" });
      continue;
    }
    const cited: Claim[] = [];
    for (const id of b.claim_ids) {
      const c = byId.get(id);
      if (!c) issues.push({ block: text, problem: "unknown_claim", detail: `claim id "${id}" does not exist` });
      else if (!isUsable(c, use)) issues.push({ block: text, problem: "claim_not_usable", detail: `claim "${id}" is ${c.status} / not permitted for ${use}` });
      else cited.push(c);
    }
    if (!cited.length) continue;
    const support = cited.map((c) => `${c.claim_text} ${c.dates}`).join(" \n ");
    const supportNums = numbersIn(support);
    for (const n of numbersIn(text)) {
      if (!supportNums.has(n)) issues.push({ block: text, problem: "number_not_in_claims", detail: `"${n}" does not appear in cited claims (${b.claim_ids.join(", ")})` });
    }
    const supportTerms = new Set(findTerms(support, ctx.techTerms));
    for (const t of findTerms(text, ctx.techTerms)) {
      if (!supportTerms.has(t)) issues.push({ block: text, problem: "tech_not_in_claims", detail: `"${t}" does not appear in cited claims (${b.claim_ids.join(", ")})` });
    }
  }
  return issues;
}
