/** Extracts in-office days per week and travel expectations from posting text. */

export interface OfficeDays {
  days: number;
  evidence: string;
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const DAY_IDX: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };
const OFFICE_WORDS = /office|in[- ]person|on[- ]?site|onsite|\bhq\b|headquarters|hybrid|studio|campus/i;

function num(s: string): number {
  return WORD_NUM[s.toLowerCase()] ?? parseInt(s, 10);
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function extractOfficeDays(texts: string[]): OfficeDays | null {
  let best: OfficeDays | null = null;
  const consider = (days: number, evidence: string) => {
    if (!(days > 0 && days <= 5)) return;
    if (!best || days > best.days) best = { days: Math.round(days * 10) / 10, evidence: evidence.slice(0, 220) };
  };

  for (const s of texts.flatMap(sentences)) {
    if (!OFFICE_WORDS.test(s)) continue;
    // "fully onsite", "5 days in office", "full-time in the office"
    if (/fully (on[- ]?site|in[- ]office|in[- ]person)|full[- ]time (in|at) (the |our )?office|in[- ]office (role|position)|on[- ]?site (role|position)|100% (on[- ]?site|in[- ]office|in[- ]person)/i.test(s)) {
      consider(5, s);
    }
    // "3 days a week", "three days per week", "3x/week", "3+ days/week"
    for (const m of s.matchAll(/\b([1-5]|one|two|three|four|five)\s*\+?\s*(?:or more\s*)?(?:days?|x)\s*(?:a|per|each|\/|every)\s*week/gi)) {
      consider(num(m[1]!), s);
    }
    // "3 days in the office", "four days on-site"
    for (const m of s.matchAll(/\b([1-5]|one|two|three|four|five)\s*\+?\s*days?\s*(?:a week\s*)?(?:in|at|from|on)[- ]?\s*(?:the |our |one of our )?(?:office|hq|headquarters|on[- ]?site|onsite|studio|person)/gi)) {
      consider(num(m[1]!), s);
    }
    // "Monday through Thursday in office"
    for (const m of s.matchAll(/\b(monday|tuesday|wednesday|thursday|friday)s?\s*(?:through|thru|to|-|–)\s*(monday|tuesday|wednesday|thursday|friday)/gi)) {
      const a = DAY_IDX[m[1]!.toLowerCase()]!;
      const b = DAY_IDX[m[2]!.toLowerCase()]!;
      if (b >= a) consider(b - a + 1, s);
    }
    // "in-person 25% of the time", "60% in office"
    for (const m of s.matchAll(/\b(\d{2,3})\s?%/g)) {
      const pct = parseInt(m[1]!, 10);
      const near = s.slice(Math.max(0, m.index! - 60), m.index! + m[0].length + 60);
      if (/travel|remote/i.test(near) || !/in[- ]office|in the office|our offices?|in[- ]person|on[- ]?site|onsite/i.test(near)) continue;
      if (pct > 0 && pct <= 100) consider((pct / 100) * 5, s);
    }
  }
  return best;
}

export function extractTravel(text: string): string | null {
  const patterns = [
    /[^.\n]{0,80}\btravel(?:ing)?\b[^.\n]{0,40}\b\d{1,2}\s?%[^.\n]{0,40}/i,
    /[^.\n]{0,60}\b(?:quarterly|annual|monthly|bi-?annual|twice a year)\s+(?:team\s+|company\s+)?(?:off-?sites?|on-?sites?|gatherings?|in-person|retreats?|summits?)[^.\n]{0,60}/i,
    /[^.\n]{0,60}\b(?:occasional|periodic|regular|frequent)\s+travel[^.\n]{0,60}/i,
    /[^.\n]{0,60}\btravel (?:to|for) (?:our |the )?(?:hq|headquarters|office|customer|client)[^.\n]{0,60}/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].replace(/\s+/g, " ").trim();
  }
  return null;
}
