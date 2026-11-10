import type { Claim } from "../evidence/claims.js";
import type { CoverLetter, ResumeDraft } from "./schemas.js";

export interface Profile {
  name: string;
  location: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
}

/**
 * Education and publications are rendered from claims verbatim, never written by the model.
 * Convention: claim ids starting with "edu-" then "pub-", in file order.
 */
const fixedSectionClaims = (claims: Claim[]) => [...claims.filter((c) => c.id.startsWith("edu-")), ...claims.filter((c) => c.id.startsWith("pub-"))];

export function renderResume(d: ResumeDraft, profile: Profile, claims: Claim[]): string {
  const contact = [profile.location, profile.email, profile.phone, profile.linkedin.replace(/^https?:\/\/(www\.)?/, ""), profile.github.replace(/^https?:\/\//, "")].join(" | ");
  const out: string[] = [`# ${profile.name}`, contact, "", "## Summary", d.summary.map((b) => b.text.trim()).join(" "), ""];
  out.push("## Experience");
  for (const e of d.experience) {
    out.push(`### ${e.heading.trim()}`);
    for (const b of e.bullets) out.push(`- ${b.text.trim()}`);
    out.push("");
  }
  const projects = d.projects ?? [];
  if (projects.length) {
    out.push("## Projects");
    for (const e of projects) {
      out.push(`### ${e.heading.trim()}`);
      for (const b of e.bullets) out.push(`- ${b.text.trim()}`);
      out.push("");
    }
  }
  out.push("## Education & Research");
  for (const c of fixedSectionClaims(claims)) {
    if ((c.status === "VERIFIED" || c.status === "USER_CONFIRMED") && c.permitted_use.includes("resume")) out.push(`- ${c.claim_text}`);
  }
  out.push("", "## Skills", d.skills.text.trim(), "");
  return out.join("\n");
}

export function renderCoverLetter(c: CoverLetter, profile: Profile, company: string): string {
  return [`Dear ${company} hiring team,`, "", ...c.paragraphs.map((p) => p.blocks.map((b) => b.text.trim()).join(" ")).flatMap((p) => [p, ""]), "Best,", profile.name].join("\n");
}
