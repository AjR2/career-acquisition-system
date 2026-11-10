import { extractOfficeDays, extractTravel, type OfficeDays } from "./attendance.js";

export type LocationClass =
  | "REMOTE_US"
  | "REMOTE_DC_REGION"
  | "REMOTE_UNSPECIFIED"
  | "HYBRID_DC"
  | "ONSITE_DC"
  | "OFFICE_DC_UNSPECIFIED"
  | "REMOTE_NON_US"
  | "REMOTE_REGION_RESTRICTED"
  | "OFFICE_OTHER_US"
  | "OFFICE_NON_US"
  | "UNKNOWN";

const ACCEPTABLE: Record<LocationClass, boolean | null> = {
  REMOTE_US: true,
  REMOTE_DC_REGION: true,
  REMOTE_UNSPECIFIED: true,
  HYBRID_DC: true,
  ONSITE_DC: true,
  OFFICE_DC_UNSPECIFIED: true,
  REMOTE_NON_US: false,
  REMOTE_REGION_RESTRICTED: false,
  OFFICE_OTHER_US: false,
  OFFICE_NON_US: false,
  UNKNOWN: null,
};
const RANK: LocationClass[] = [
  "REMOTE_US", "REMOTE_DC_REGION", "HYBRID_DC", "OFFICE_DC_UNSPECIFIED", "ONSITE_DC", "REMOTE_UNSPECIFIED",
  "UNKNOWN", "REMOTE_REGION_RESTRICTED", "OFFICE_OTHER_US", "REMOTE_NON_US", "OFFICE_NON_US",
];

export interface LocationResult {
  classification: LocationClass;
  acceptable: boolean | null;
  /** For remote classes: whether the organization describes itself as remote-first. */
  remoteMode: "REMOTE_FIRST" | "REMOTE_ELIGIBLE" | null;
  officeDays: OfficeDays | null;
  travel: string | null;
  contradiction: string | null;
  segments: { text: string; cls: LocationClass }[];
  reason: string;
}

export interface LocationInput {
  title: string;
  locations: string[];
  locationRaw: string;
  workplaceType: "remote" | "hybrid" | "onsite" | null;
  country: string | null;
  descriptionText: string;
  questionLabels: string[];
  companyRemoteFirst?: boolean;
}

const REMOTE = /\bremote\b|\banywhere\b|distributed|work from home|\bwfh\b/i;
const US = /\b(us|u\.s\.a?\.?|usa|united states|america|americas|amer|north america|us[- ]based)\b/i;
const NON_US = /\b(canada|toronto|vancouver|montreal|uk|u\.k\.|united kingdom|england|london|ireland|dublin|europe|european|eu|emea|apac|asia|india|bangalore|bengaluru|hyderabad|germany|berlin|munich|france|paris|spain|madrid|barcelona|poland|warsaw|netherlands|amsterdam|portugal|lisbon|sweden|stockholm|switzerland|zurich|israel|tel aviv|japan|tokyo|singapore|australia|sydney|melbourne|brazil|s[aã]o paulo|mexico|latam|latin america|argentina|colombia|korea|seoul|china|taiwan|philippines|romania|ukraine|serbia|denmark|copenhagen|norway|finland|italy|milan|austria|vienna, austria|belgium|czech|prague|hungary|greece|turkey|uae|dubai|south africa|nigeria|kenya|new zealand)\b/i;
// Non-DC US places that make a "remote" location regional, or an office location non-local.
const US_PLACE = /\b(san francisco|sf\b|bay area|silicon valley|palo alto|mountain view|menlo park|sunnyvale|san jose|oakland|berkeley|new york|nyc|brooklyn|seattle|bellevue|redmond|austin|dallas|houston|boston|cambridge|chicago|los angeles|la\b|santa monica|san diego|denver|boulder|atlanta|miami|philadelphia|pittsburgh|portland|salt lake|phoenix|minneapolis|detroit|nashville|raleigh|durham|charlotte|columbus|baltimore|new jersey|connecticut|california|texas|washington state|massachusetts|colorado|illinois|florida|georgia|oregon|utah|arizona|pacific time)\b|,\s?(ca|ny|wa|tx|ma|co|il|fl|ga|or|ut|az|nj|pa|nc|mn|mi|tn|oh)\b/i;
const AMBIGUOUS_DC = /\b(arlington|alexandria|vienna|fairfax|potomac|kensington|wheaton|bethesda)\b/i;
const OTHER_STATE = /,\s?(tx|texas|ma|massachusetts|ca|wa|ny|il|oh|pa)\b|austria|texas/i;
const REMOTE_FIRST = /remote[- ]first|all[- ]remote|fully[- ]distributed|distributed[- ]first|remote company|fully remote company|remote-native/i;

function isDc(seg: string, dcList: string[]): boolean {
  const s = seg.toLowerCase();
  // "DC" shorthand counts only when the user's commute list is in the DC area.
  const dcHome = dcList.some((p) => /washington|district of columbia|\bdc\b|d\.c\./.test(p));
  if (dcHome && /\bdc\b|d\.c\./i.test(seg) && !/\bdc\b\s*(motor|power)/i.test(seg)) return true;
  const hit = dcList.some((p) => s.includes(p));
  if (!hit) return false;
  if (AMBIGUOUS_DC.test(seg) && OTHER_STATE.test(seg)) return false;
  return true;
}

function classifySegment(seg: string, dcList: string[], wt: LocationInput["workplaceType"], country: string | null): LocationClass {
  const remote = REMOTE.test(seg) || wt === "remote";
  const dc = isDc(seg, dcList);
  const nonUs = NON_US.test(seg) && !US.test(seg.replace(/\b(north|latin|south) america\b/gi, ""));
  const usPlace = US_PLACE.test(seg);
  if (remote) {
    if (nonUs) return "REMOTE_NON_US";
    if (dc) return "REMOTE_DC_REGION";
    if (US.test(seg)) return "REMOTE_US";
    if (usPlace) return REMOTE.test(seg) ? "REMOTE_REGION_RESTRICTED" : countryClass(country, "REMOTE_US");
    // Bare "Remote": use the ATS country if present.
    return countryClass(country, "REMOTE_UNSPECIFIED");
  }
  if (dc) return wt === "hybrid" ? "HYBRID_DC" : wt === "onsite" ? "ONSITE_DC" : "OFFICE_DC_UNSPECIFIED";
  if (nonUs) return "OFFICE_NON_US";
  if (usPlace || US.test(seg)) return "OFFICE_OTHER_US";
  if (country && !/^(us|usa|united states)$/i.test(country)) return "OFFICE_NON_US";
  return seg.trim() ? "OFFICE_OTHER_US" : "UNKNOWN";
}

function countryClass(country: string | null, fallback: LocationClass): LocationClass {
  if (!country) return fallback;
  if (/^(us|usa|united states|united states of america)$/i.test(country.trim())) return fallback === "REMOTE_UNSPECIFIED" ? "REMOTE_US" : fallback;
  return "REMOTE_NON_US";
}

export function classifyLocation(input: LocationInput, cfg: { dc_metro: string[]; remote_ok?: boolean }): LocationResult {
  const segs = input.locations.length ? input.locations : input.locationRaw ? [input.locationRaw] : [];
  // A title like "Software Engineer (Remote, US)" counts as a location statement.
  const titleLoc = input.title.match(/\(([^)]*\b(remote|us|dc)\b[^)]*)\)/i)?.[1];
  if (titleLoc) segs.push(titleLoc);

  const segments = segs.map((text) => ({ text, cls: classifySegment(text, cfg.dc_metro, input.workplaceType, input.country) }));
  const text = input.descriptionText;
  let officeDays = extractOfficeDays([text, ...input.questionLabels]);
  if (!officeDays && input.workplaceType === "onsite") officeDays = { days: 5, evidence: "ATS lists the workplace type as on-site; no day count stated" };
  const travel = extractTravel(text);
  const remoteFirst = Boolean(input.companyRemoteFirst) || REMOTE_FIRST.test(text);

  let classification: LocationClass = "UNKNOWN";
  if (segments.length) classification = [...segments].sort((a, b) => RANK.indexOf(a.cls) - RANK.indexOf(b.cls))[0]!.cls;
  else if (input.workplaceType === "remote") classification = countryClass(input.country, "REMOTE_UNSPECIFIED");

  // A DC office with unstated arrangement: use the description to decide hybrid vs onsite.
  if (classification === "OFFICE_DC_UNSPECIFIED") {
    if (/\bhybrid\b/i.test(text) || (officeDays && officeDays.days < 5)) classification = "HYBRID_DC";
    else if (officeDays && officeDays.days >= 5) classification = "ONSITE_DC";
  }

  // Remote label vs. text that requires regular office attendance.
  let contradiction: string | null = null;
  const isRemoteClass = classification.startsWith("REMOTE_");
  if (isRemoteClass && officeDays && officeDays.days >= 1) {
    const allRemote = segments.length > 0 && segments.every((s) => s.cls.startsWith("REMOTE_"));
    const officeInDc = isDc(officeDays.evidence, cfg.dc_metro);
    if (officeInDc) {
      classification = officeDays.days >= 5 ? "ONSITE_DC" : "HYBRID_DC";
    } else if (allRemote) {
      contradiction = `labeled remote but text requires ${officeDays.days} office day(s)/week: "${officeDays.evidence}"`;
    } else {
      contradiction = `remote option listed, but text also mentions ${officeDays.days} office day(s)/week (may apply only to office locations): "${officeDays.evidence}"`;
    }
  }

  let acceptable = ACCEPTABLE[classification];
  let reason = `location ${classification}`;
  const remoteOff = cfg.remote_ok === false && classification.startsWith("REMOTE_") && classification !== "REMOTE_DC_REGION";
  if (remoteOff) {
    acceptable = false;
    reason = "remote roles are turned off (location.remote_ok: false)";
  }
  if (contradiction && segments.every((s) => s.cls.startsWith("REMOTE_"))) {
    acceptable = false;
    reason = contradiction;
  }
  if (acceptable === false && !contradiction && !remoteOff) {
    reason = `location not acceptable (${classification}: ${segments.map((s) => s.text).join(" | ") || input.workplaceType || "none"})`;
  }

  return {
    classification,
    acceptable,
    remoteMode: classification.startsWith("REMOTE_") ? (remoteFirst ? "REMOTE_FIRST" : "REMOTE_ELIGIBLE") : null,
    officeDays,
    travel,
    contradiction,
    segments,
    reason,
  };
}
