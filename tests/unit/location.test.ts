import { describe, expect, it } from "vitest";
import { extractOfficeDays, extractTravel } from "../../src/eligibility/attendance.js";
import { classifyLocation, type LocationInput } from "../../src/eligibility/location.js";
import { cfg } from "../helpers.js";

const loc = (over: Partial<LocationInput>) =>
  classifyLocation({ title: "Software Engineer", locations: [], locationRaw: "", workplaceType: null, country: null, descriptionText: "", questionLabels: [], ...over }, cfg.location);

describe("remote classification", () => {
  it.each([
    ["Remote - US", "REMOTE_US"],
    ["Remote (United States)", "REMOTE_US"],
    ["US Remote", "REMOTE_US"],
    ["Remote - AMER", "REMOTE_US"],
    ["Remote - Canada", "REMOTE_NON_US"],
    ["Remote, EMEA", "REMOTE_NON_US"],
    ["Remote - San Francisco Bay Area", "REMOTE_REGION_RESTRICTED"],
    ["Remote", "REMOTE_UNSPECIFIED"],
    ["Remote - Washington, DC", "REMOTE_DC_REGION"],
  ])("%s -> %s", (s, expected) => {
    expect(loc({ locations: [s] }).classification).toBe(expected);
  });

  it("uses ATS workplace type plus country when the location is a city", () => {
    expect(loc({ locations: ["San Francisco"], workplaceType: "remote", country: "United States" }).classification).toBe("REMOTE_US");
    expect(loc({ locations: ["London"], workplaceType: "remote", country: "United Kingdom" }).classification).toBe("REMOTE_NON_US");
  });

  it("picks the best option across multiple locations", () => {
    const r = loc({ locations: ["San Francisco, CA", "New York, NY", "Remote (US)"] });
    expect(r.classification).toBe("REMOTE_US");
    expect(r.acceptable).toBe(true);
  });

  it("distinguishes remote-first from remote-eligible", () => {
    expect(loc({ locations: ["Remote - US"], descriptionText: "We are a remote-first company." }).remoteMode).toBe("REMOTE_FIRST");
    expect(loc({ locations: ["Remote - US"], descriptionText: "This role can be remote." }).remoteMode).toBe("REMOTE_ELIGIBLE");
  });
});

describe("DC metro and office roles", () => {
  it("accepts hybrid DC-area roles and reads office days", () => {
    const r = loc({ locations: ["Arlington, VA"], descriptionText: "This is a hybrid role with 3 days a week in our Arlington office." });
    expect(r.classification).toBe("HYBRID_DC");
    expect(r.acceptable).toBe(true);
    expect(r.officeDays?.days).toBe(3);
  });

  it("treats Washington, D.C. as DC but not Washington state", () => {
    expect(loc({ locations: ["Washington, D.C."], workplaceType: "hybrid" }).classification).toBe("HYBRID_DC");
    expect(loc({ locations: ["Seattle, WA"], workplaceType: "hybrid" }).acceptable).toBe(false);
  });

  it("does not treat Arlington, TX as DC metro", () => {
    expect(loc({ locations: ["Arlington, TX"], workplaceType: "onsite" }).acceptable).toBe(false);
  });

  it("rejects offices outside the DC metro (relocation)", () => {
    const r = loc({ locations: ["New York, NY"], workplaceType: "hybrid" });
    expect(r.classification).toBe("OFFICE_OTHER_US");
    expect(r.acceptable).toBe(false);
  });

  it("infers 5 office days for an on-site DC role with no stated count", () => {
    const r = loc({ locations: ["Washington, D.C."], workplaceType: "onsite" });
    expect(r.classification).toBe("ONSITE_DC");
    expect(r.officeDays?.days).toBe(5);
  });
});

describe("contradictory remote policy", () => {
  it("rejects a remote label whose text requires weekly office attendance elsewhere", () => {
    const r = loc({ locations: ["Remote - US"], descriptionText: "You will be expected to work from our San Francisco office 3 days per week." });
    expect(r.acceptable).toBe(false);
    expect(r.contradiction).toMatch(/labeled remote/);
  });

  it("flags but keeps a posting that lists both a remote option and an office with days", () => {
    const r = loc({ locations: ["Hybrid - New York", "Remote - US"], descriptionText: "This is a hybrid role based in New York, with three days a week in the office." });
    expect(r.acceptable).toBe(true);
    expect(r.contradiction).toMatch(/may apply only/);
  });

  it("reclassifies remote-labeled roles that require days in a DC office as hybrid DC", () => {
    const r = loc({ locations: ["Remote - US"], descriptionText: "You will work from our Washington, DC office two days a week." });
    expect(r.classification).toBe("HYBRID_DC");
    expect(r.acceptable).toBe(true);
  });
});

describe("office days extraction", () => {
  it.each([
    ["We work in the office three days per week.", 3],
    ["Hybrid: 2x/week in office.", 2],
    ["You'll be in our office Monday through Thursday.", 4],
    ["This is a fully onsite role.", 5],
    ["Are you open to working in-person in one of our offices 25% of the time?", 1.3],
    ["4+ days in the office each week", 4],
  ])("%s -> %d", (s, days) => {
    expect(extractOfficeDays([s])?.days).toBe(days);
  });

  it("ignores percentages unrelated to office attendance", () => {
    expect(extractOfficeDays(["We are 100% remote and have no office."])).toBeNull();
    expect(extractOfficeDays(["Travel up to 25% to customer sites."])).toBeNull();
  });

  it("extracts travel expectations", () => {
    expect(extractTravel("Expect travel up to 20% for customer visits.")).toMatch(/20%/);
    expect(extractTravel("We gather for quarterly offsites in person.")).toMatch(/quarterly offsites/);
  });
});

describe("remote_ok switch", () => {
  it("rejects remote roles when the user wants local only, but keeps commute-area roles", () => {
    const local = { ...cfg.location, remote_ok: false };
    const r = classifyLocation({ title: "X", locations: ["Remote - US"], locationRaw: "", workplaceType: null, country: null, descriptionText: "", questionLabels: [] }, local);
    expect(r.acceptable).toBe(false);
    expect(r.reason).toMatch(/remote roles are turned off/);
    const dc = classifyLocation({ title: "X", locations: ["Arlington, VA"], locationRaw: "", workplaceType: "hybrid", country: null, descriptionText: "", questionLabels: [] }, local);
    expect(dc.acceptable).toBe(true);
  });
});
