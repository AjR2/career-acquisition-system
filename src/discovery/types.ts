export type Ats = "greenhouse" | "lever" | "ashby";

export interface CompanyConfig {
  name: string;
  ats: Ats;
  token: string;
  priority: "A" | "B";
  remote_first?: boolean;
  note?: string;
}

/** A structured pay range as published by the ATS (not parsed from text). */
export interface StructuredPay {
  min: number | null;
  max: number | null;
  currency: string;
  interval: "year" | "hour" | "month" | "unknown";
  /** Label/blurb the ATS attached, used to tell base salary from OTE. */
  label?: string;
  source: string;
}

export interface ApplicationQuestion {
  label: string;
  required: boolean;
  fieldTypes: string[];
  /** Option labels for select fields (truncated). */
  options?: string[];
}

export interface NormalizedPosting {
  ats: Ats;
  companyToken: string;
  companyName: string;
  atsJobId: string;
  title: string;
  url: string;
  applyUrl: string | null;
  sourceUrl: string;
  locationRaw: string;
  /** Every location string the posting lists. */
  locations: string[];
  /** Workplace type when the ATS states it explicitly. */
  workplaceType: "remote" | "hybrid" | "onsite" | null;
  country: string | null;
  employmentTypeRaw: string | null;
  descriptionText: string;
  structuredPay: StructuredPay[];
  aiDisclaimer: string | null;
  questions: ApplicationQuestion[] | null;
  hasDemographicQuestions: boolean;
  deadline: string | null;
  publishedAt: string | null;
  raw: unknown;
}

export interface FetchResult {
  status: number;
  json: unknown;
  /** Network error detail when status is 0. */
  error?: string;
}

export type Fetcher = (url: string) => Promise<FetchResult>;
