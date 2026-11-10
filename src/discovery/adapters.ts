import { z } from "zod";
import { htmlToText } from "../normalize/html.js";
import type { ApplicationQuestion, CompanyConfig, Fetcher, NormalizedPosting, StructuredPay } from "./types.js";

export type BoardResult =
  | { ok: true; postings: NormalizedPosting[]; listed: number; detailFailures: number; skippedUnlisted: number }
  | { ok: false; status: number; error: string };

export interface BoardOptions {
  /** Greenhouse only: fetch per-job detail (pay + questions) when this returns true for the title. */
  wantDetail?: (title: string, location: string) => boolean;
}

// ---------- Greenhouse ----------

const GhJob = z.looseObject({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  location: z.looseObject({ name: z.string().nullish() }).nullish(),
  content: z.string().nullish(),
  updated_at: z.string().nullish(),
  first_published: z.string().nullish(),
  company_name: z.string().nullish(),
  application_deadline: z.string().nullish(),
  metadata: z.array(z.looseObject({ name: z.string().nullish(), value: z.unknown() })).nullish(),
  offices: z.array(z.looseObject({ name: z.string().nullish(), location: z.string().nullish() })).nullish(),
});
const GhList = z.looseObject({ jobs: z.array(GhJob) });
const GhDetail = GhJob.extend({
  pay_input_ranges: z
    .array(z.looseObject({ min_cents: z.number().nullish(), max_cents: z.number().nullish(), currency_type: z.string().nullish(), title: z.string().nullish(), blurb: z.string().nullish() }))
    .nullish(),
  questions: z
    .array(
      z.looseObject({
        label: z.string(),
        required: z.boolean().nullish(),
        fields: z.array(z.looseObject({ type: z.string(), values: z.array(z.looseObject({ label: z.unknown() })).nullish() })).nullish(),
      }),
    )
    .nullish(),
  demographic_questions: z.unknown().nullish(),
  ai_disclaimer: z.string().nullish(),
  include_ai_disclaimer: z.boolean().nullish(),
});

function ghWorkplace(metadata: z.infer<typeof GhJob>["metadata"]): NormalizedPosting["workplaceType"] {
  const v = metadata?.find((m) => /location type|workplace|remote/i.test(m.name ?? ""))?.value;
  const s = typeof v === "string" ? v.toLowerCase() : Array.isArray(v) ? v.join(" ").toLowerCase() : "";
  if (/remote/.test(s)) return "remote";
  if (/hybrid/.test(s)) return "hybrid";
  if (/on-?site|in office|in-office/.test(s)) return "onsite";
  return null;
}

function ghQuestions(qs: z.infer<typeof GhDetail>["questions"]): ApplicationQuestion[] | null {
  if (!qs) return null;
  return qs.map((q) => ({
    label: q.label.trim(),
    required: Boolean(q.required),
    fieldTypes: (q.fields ?? []).map((f) => f.type),
    options: (q.fields ?? []).flatMap((f) => (f.values ?? []).map((v) => String(v.label))).slice(0, 20),
  }));
}

export async function fetchGreenhouse(c: CompanyConfig, fetcher: Fetcher, opts: BoardOptions = {}): Promise<BoardResult> {
  const listUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.token)}/jobs?content=true`;
  const res = await fetcher(listUrl);
  if (res.status !== 200) return { ok: false, status: res.status, error: res.error ? `network error: ${res.error}` : `list fetch returned ${res.status}` };
  const parsed = GhList.safeParse(res.json);
  if (!parsed.success) return { ok: false, status: res.status, error: "unexpected list response shape" };

  const postings: NormalizedPosting[] = [];
  let detailFailures = 0;
  for (const job of parsed.data.jobs) {
    let detail: z.infer<typeof GhDetail> | null = null;
    if (opts.wantDetail?.(job.title, job.location?.name ?? "")) {
      const dUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.token)}/jobs/${job.id}?pay_transparency=true&questions=true`;
      const d = await fetcher(dUrl);
      const dp = d.status === 200 ? GhDetail.safeParse(d.json) : null;
      if (dp?.success) detail = dp.data;
      else detailFailures++;
    }
    const j = detail ?? job;
    const offices = (j.offices ?? []).map((o) => o.location || o.name || "").filter(Boolean);
    const locName = j.location?.name ?? "";
    const pay: StructuredPay[] = (detail?.pay_input_ranges ?? []).map((p) => ({
      min: p.min_cents != null ? p.min_cents / 100 : null,
      max: p.max_cents != null ? p.max_cents / 100 : null,
      currency: p.currency_type ?? "USD",
      interval: /hour/i.test(p.title ?? "") ? "hour" : "year",
      label: `${p.title ?? ""} ${htmlToText(p.blurb ?? "")}`.trim(),
      source: "greenhouse.pay_input_ranges",
    }));
    postings.push({
      ats: "greenhouse",
      companyToken: c.token,
      companyName: c.name,
      atsJobId: String(j.id),
      title: j.title.trim(),
      url: j.absolute_url,
      applyUrl: j.absolute_url,
      sourceUrl: listUrl,
      locationRaw: locName,
      locations: uniq([...splitLocations(locName), ...offices]),
      workplaceType: ghWorkplace(j.metadata),
      country: null,
      employmentTypeRaw: null,
      descriptionText: htmlToText(j.content),
      structuredPay: pay,
      aiDisclaimer: detail?.include_ai_disclaimer && detail.ai_disclaimer ? htmlToText(detail.ai_disclaimer) : null,
      questions: ghQuestions(detail?.questions),
      hasDemographicQuestions: Boolean(detail?.demographic_questions),
      deadline: j.application_deadline ?? null,
      publishedAt: j.first_published ?? j.updated_at ?? null,
      raw: detail ?? job,
    });
  }
  return { ok: true, postings, listed: parsed.data.jobs.length, detailFailures, skippedUnlisted: 0 };
}

// ---------- Lever ----------

const LeverPosting = z.looseObject({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  applyUrl: z.string().nullish(),
  createdAt: z.number().nullish(),
  country: z.string().nullish(),
  workplaceType: z.string().nullish(),
  categories: z
    .looseObject({ commitment: z.string().nullish(), location: z.string().nullish(), allLocations: z.array(z.string()).nullish() })
    .nullish(),
  descriptionPlain: z.string().nullish(),
  description: z.string().nullish(),
  lists: z.array(z.looseObject({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  additionalPlain: z.string().nullish(),
  additional: z.string().nullish(),
  salaryRange: z.looseObject({ min: z.number().nullish(), max: z.number().nullish(), currency: z.string().nullish(), interval: z.string().nullish() }).nullish(),
  salaryDescriptionPlain: z.string().nullish(),
});

export async function fetchLever(c: CompanyConfig, fetcher: Fetcher): Promise<BoardResult> {
  const listUrl = `https://api.lever.co/v0/postings/${encodeURIComponent(c.token)}?mode=json`;
  const res = await fetcher(listUrl);
  if (res.status !== 200) return { ok: false, status: res.status, error: res.error ? `network error: ${res.error}` : `list fetch returned ${res.status}` };
  const parsed = z.array(LeverPosting).safeParse(res.json);
  if (!parsed.success) return { ok: false, status: res.status, error: "unexpected list response shape" };

  const postings = parsed.data.map((p): NormalizedPosting => {
    const lists = (p.lists ?? []).map((l) => `${l.text ?? ""}\n${htmlToText(l.content)}`).join("\n\n");
    const description = [p.descriptionPlain ?? htmlToText(p.description), lists, p.additionalPlain ?? htmlToText(p.additional), p.salaryDescriptionPlain ?? ""]
      .filter(Boolean)
      .join("\n\n");
    const wt = (p.workplaceType ?? "").toLowerCase();
    const sr = p.salaryRange;
    const interval = (sr?.interval ?? "").toLowerCase();
    return {
      ats: "lever",
      companyToken: c.token,
      companyName: c.name,
      atsJobId: p.id,
      title: p.text.trim(),
      url: p.hostedUrl,
      applyUrl: p.applyUrl ?? null,
      sourceUrl: listUrl,
      locationRaw: p.categories?.location ?? "",
      locations: uniq([...(p.categories?.allLocations ?? []), ...splitLocations(p.categories?.location ?? "")]),
      workplaceType: wt === "remote" ? "remote" : wt === "hybrid" ? "hybrid" : wt === "onsite" || wt === "on-site" ? "onsite" : null,
      country: p.country ?? null,
      employmentTypeRaw: p.categories?.commitment ?? null,
      descriptionText: description,
      structuredPay: sr
        ? [{ min: sr.min ?? null, max: sr.max ?? null, currency: sr.currency ?? "USD", interval: interval.includes("hour") ? "hour" : interval.includes("year") ? "year" : interval.includes("month") ? "month" : "unknown", source: "lever.salaryRange" }]
        : [],
      aiDisclaimer: null,
      questions: null,
      hasDemographicQuestions: false,
      deadline: null,
      publishedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      raw: p,
    };
  });
  return { ok: true, postings, listed: parsed.data.length, detailFailures: 0, skippedUnlisted: 0 };
}

// ---------- Ashby ----------

const AshbyComp = z.looseObject({
  compensationType: z.string().nullish(),
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});
const AshbyAddress = z.looseObject({ postalAddress: z.looseObject({ addressCountry: z.string().nullish(), addressLocality: z.string().nullish(), addressRegion: z.string().nullish() }).nullish() }).nullish();
const AshbyJob = z.looseObject({
  id: z.string(),
  title: z.string(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.looseObject({ location: z.string().nullish(), address: AshbyAddress })).nullish(),
  workplaceType: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  employmentType: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  jobUrl: z.string(),
  applyUrl: z.string().nullish(),
  publishedAt: z.string().nullish(),
  address: AshbyAddress,
  compensation: z
    .looseObject({ summaryComponents: z.array(AshbyComp).nullish(), compensationTierSummary: z.string().nullish() })
    .nullish(),
});

export async function fetchAshby(c: CompanyConfig, fetcher: Fetcher): Promise<BoardResult> {
  const listUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.token)}?includeCompensation=true`;
  const res = await fetcher(listUrl);
  if (res.status !== 200) return { ok: false, status: res.status, error: res.error ? `network error: ${res.error}` : `list fetch returned ${res.status}` };
  const parsed = z.looseObject({ jobs: z.array(AshbyJob) }).safeParse(res.json);
  if (!parsed.success) return { ok: false, status: res.status, error: "unexpected list response shape" };

  let skippedUnlisted = 0;
  const postings: NormalizedPosting[] = [];
  for (const j of parsed.data.jobs) {
    if (j.isListed === false) {
      skippedUnlisted++;
      continue;
    }
    const wt = (j.workplaceType ?? "").toLowerCase();
    const secondary = (j.secondaryLocations ?? []).map((s) => s.location ?? "").filter(Boolean);
    const pay: StructuredPay[] = (j.compensation?.summaryComponents ?? [])
      .filter((s) => s.compensationType === "Salary")
      .map((s) => ({
        min: s.minValue ?? null,
        max: s.maxValue ?? null,
        currency: s.currencyCode ?? "USD",
        interval: /hour/i.test(s.interval ?? "") ? "hour" : /year/i.test(s.interval ?? "") ? "year" : /month/i.test(s.interval ?? "") ? "month" : "unknown",
        label: j.compensation?.compensationTierSummary ?? undefined,
        source: "ashby.compensation",
      }));
    postings.push({
      ats: "ashby",
      companyToken: c.token,
      companyName: c.name,
      atsJobId: j.id,
      title: j.title.trim(),
      url: j.jobUrl,
      applyUrl: j.applyUrl ?? null,
      sourceUrl: listUrl,
      locationRaw: j.location ?? "",
      locations: uniq([...splitLocations(j.location ?? ""), ...secondary]),
      // The stated workplace type wins; some boards set isRemote=true on hybrid roles.
      workplaceType: wt === "remote" ? "remote" : wt === "hybrid" ? "hybrid" : wt === "onsite" ? "onsite" : j.isRemote ? "remote" : null,
      country: j.address?.postalAddress?.addressCountry ?? null,
      employmentTypeRaw: j.employmentType ?? null,
      descriptionText: j.descriptionPlain?.trim() || htmlToText(j.descriptionHtml),
      structuredPay: pay,
      aiDisclaimer: null,
      questions: null,
      hasDemographicQuestions: false,
      deadline: null,
      publishedAt: j.publishedAt ?? null,
      raw: j,
    });
  }
  return { ok: true, postings, listed: parsed.data.jobs.length, detailFailures: 0, skippedUnlisted };
}

// ---------- shared ----------

export function fetchBoard(c: CompanyConfig, fetcher: Fetcher, opts: BoardOptions = {}): Promise<BoardResult> {
  switch (c.ats) {
    case "greenhouse":
      return fetchGreenhouse(c, fetcher, opts);
    case "lever":
      return fetchLever(c, fetcher);
    case "ashby":
      return fetchAshby(c, fetcher);
  }
}

/** Splits "San Francisco, CA | Seattle, WA" or "NYC; Remote (US)" into separate locations. */
export function splitLocations(s: string): string[] {
  return s
    .split(/\s*(?:\||;|\/|\bor\b|•)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}
