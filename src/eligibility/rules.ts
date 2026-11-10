import type { CompanyConfig, NormalizedPosting } from "../discovery/types.js";
import type { EligibilityConfig } from "../config/files.js";
import { classifyClearance, classifyEmployment, classifyRole, detectAiPolicy, type ClearanceResult, type EmploymentType, type AiPolicyResult } from "./classifiers.js";
import { classifyLocation, type LocationResult } from "./location.js";
import { evaluateComp, type CompResult } from "./salary.js";

export const RULES_VERSION = "2026-10-21.1";

export type Lane = "primary" | "contract_to_hire" | "contract";

export interface Flag {
  code:
    | "UNKNOWN_COMP" | "NON_BASE_PAY_ONLY" | "BELOW_TARGET" | "MULTIPLE_PAY_RANGES"
    | "REMOTE_COUNTRY_UNSPECIFIED" | "LOCATION_UNKNOWN" | "REMOTE_POLICY_UNCLEAR"
    | "OFFICE_DAYS" | "OFFICE_DAYS_HIGH" | "TRAVEL"
    | "CONTRACT_TO_HIRE" | "PART_TIME" | "EMPLOYMENT_TYPE_UNSTATED"
    | "CLEARANCE_SPONSORABLE" | "CLEARANCE_PREFERRED" | "CITIZENSHIP_REQUIRED"
    | "AI_POLICY" | "DEMOGRAPHIC_QUESTIONS";
  detail: string;
}

export interface EligibilityResult {
  verdict: "ELIGIBLE" | "INELIGIBLE";
  lane: Lane;
  reasons: string[];
  flags: Flag[];
  role: { ok: boolean; reason: string };
  comp: CompResult;
  location: LocationResult;
  employment: { type: EmploymentType; evidence: string | null };
  clearance: ClearanceResult;
  aiPolicy: AiPolicyResult;
  rulesVersion: string;
}

export function evaluateEligibility(
  p: NormalizedPosting,
  cfg: EligibilityConfig,
  company?: Pick<CompanyConfig, "remote_first">,
  now: Date = new Date(),
): EligibilityResult {
  const reasons: string[] = [];
  const flags: Flag[] = [];
  const text = p.descriptionText;

  const role = classifyRole(p.title, cfg.roles);
  if (!role.ok) reasons.push(role.reason);

  const employment = classifyEmployment(p);
  let lane: Lane = "primary";
  if (employment.type === "INTERNSHIP") reasons.push("internship");
  if (employment.type === "PART_TIME") {
    if (cfg.roles.part_time_ok) flags.push({ code: "PART_TIME", detail: employment.evidence ?? "part-time" });
    else reasons.push("part-time (roles.part_time_ok: false)");
  }
  if (employment.type === "CONTRACT") lane = "contract";
  if (employment.type === "CONTRACT_TO_HIRE") {
    lane = "contract_to_hire";
    flags.push({ code: "CONTRACT_TO_HIRE", detail: employment.evidence ?? "contract-to-hire" });
  }

  const comp = evaluateComp(p, cfg.compensation);
  if (comp.verdict === "fail") reasons.push(comp.reason);
  if (comp.status === "UNKNOWN_COMP") flags.push({ code: "UNKNOWN_COMP", detail: comp.reason });
  if (comp.status === "NON_BASE_ONLY" && comp.verdict !== "fail") flags.push({ code: "NON_BASE_PAY_ONLY", detail: comp.reason });
  if (comp.verdict === "pass" && comp.baseMax != null && comp.baseMax < cfg.compensation.target_base_usd) {
    flags.push({ code: "BELOW_TARGET", detail: `base max $${comp.baseMax.toLocaleString("en-US")} is under the $${cfg.compensation.target_base_usd.toLocaleString("en-US")} target` });
  }
  if (comp.ranges.length > 1) flags.push({ code: "MULTIPLE_PAY_RANGES", detail: `${comp.ranges.length} ranges stated` });

  const location = classifyLocation(
    {
      title: p.title,
      locations: [...p.locations],
      locationRaw: p.locationRaw,
      workplaceType: p.workplaceType,
      country: p.country,
      descriptionText: text,
      questionLabels: (p.questions ?? []).map((q) => q.label),
      companyRemoteFirst: company?.remote_first,
    },
    cfg.location,
  );
  if (location.acceptable === false) reasons.push(location.reason);
  if (location.classification === "REMOTE_UNSPECIFIED") flags.push({ code: "REMOTE_COUNTRY_UNSPECIFIED", detail: "posting says remote without naming a country" });
  if (location.classification === "UNKNOWN") flags.push({ code: "LOCATION_UNKNOWN", detail: "no location stated" });
  if (location.contradiction && location.acceptable !== false) flags.push({ code: "REMOTE_POLICY_UNCLEAR", detail: location.contradiction });
  if (location.officeDays) {
    flags.push({ code: "OFFICE_DAYS", detail: `${location.officeDays.days} day(s)/week in office: "${location.officeDays.evidence}"` });
    if (location.officeDays.days >= cfg.location.office_days_high_threshold) {
      flags.push({ code: "OFFICE_DAYS_HIGH", detail: `${location.officeDays.days} office days/week (threshold ${cfg.location.office_days_high_threshold})` });
    }
  }
  if (!location.officeDays && (location.classification === "HYBRID_DC" || location.classification === "OFFICE_DC_UNSPECIFIED")) {
    flags.push({ code: "OFFICE_DAYS", detail: "DC-area office role; days per week in office not stated" });
  }
  if (location.travel) flags.push({ code: "TRAVEL", detail: location.travel });

  // Titles like "Solutions Engineer (Clearance Required)" carry the requirement too.
  const clearance = classifyClearance(`${p.title}\n${text}`);
  if (clearance.status === "REQUIRED" && !cfg.candidate.has_active_clearance) {
    reasons.push(`active security clearance required: "${clearance.evidence}"`);
  }
  if (clearance.status === "SPONSORSHIP_AVAILABLE") flags.push({ code: "CLEARANCE_SPONSORABLE", detail: clearance.evidence ?? "" });
  if (clearance.status === "PREFERRED") flags.push({ code: "CLEARANCE_PREFERRED", detail: clearance.evidence ?? "" });
  if (clearance.citizenshipRequired) flags.push({ code: "CITIZENSHIP_REQUIRED", detail: clearance.citizenshipRequired });

  const aiPolicy = detectAiPolicy(p);
  if (aiPolicy.detected) flags.push({ code: "AI_POLICY", detail: aiPolicy.text ?? "" });
  if (p.hasDemographicQuestions) flags.push({ code: "DEMOGRAPHIC_QUESTIONS", detail: "form has voluntary demographic questions; CAS never answers these" });

  if (p.deadline && new Date(p.deadline).getTime() < now.getTime()) reasons.push(`application deadline passed (${p.deadline})`);

  if (lane === "contract" && reasons.length === 0) reasons.push("contract lane: report only, no materials without user authorization");

  return {
    verdict: reasons.length ? "INELIGIBLE" : "ELIGIBLE",
    lane,
    reasons,
    flags,
    role,
    comp,
    location,
    employment,
    clearance,
    aiPolicy,
    rulesVersion: RULES_VERSION,
  };
}
