import { describe, expect, it } from "vitest";
import { evaluateComp, parseTextPay } from "../../src/eligibility/salary.js";

const C = { min_base_usd: 140000, hours_per_year: 2080 };
const ev = (descriptionText: string, title = "Software Engineer") => evaluateComp({ title, structuredPay: [], descriptionText }, C);

describe("salary parsing from text", () => {
  it("parses a comma range with a base label", () => {
    const [r] = parseTextPay("The base salary range for this role is $150,000 - $200,000 USD.");
    expect(r).toMatchObject({ min: 150000, max: 200000, interval: "year", basis: "base" });
  });

  it("parses k ranges and applies k to both ends", () => {
    expect(parseTextPay("Salary: $150 - $200K")[0]).toMatchObject({ min: 150000, max: 200000 });
    expect(parseTextPay("Salary range: $160k–$190k")[0]).toMatchObject({ min: 160000, max: 190000 });
  });

  it("parses ranges written without a dollar sign but with USD", () => {
    expect(parseTextPay("Pay range 145,000 to 175,000 USD per year")[0]).toMatchObject({ min: 145000, max: 175000 });
  });

  it("annualizes hourly rates", () => {
    const [r] = parseTextPay("The hourly rate is $80 - $95 per hour.");
    expect(r).toMatchObject({ interval: "hour", annualMin: 166400, annualMax: 197600 });
  });

  it("ignores funding amounts", () => {
    expect(parseTextPay("We raised $100M - $200M in our Series C and have $1 billion ARR.")).toEqual([]);
  });

  it("ignores stray dollar figures that are not pay", () => {
    expect(parseTextPay("We offer a $500 home office stipend and $2,000 learning budget.")).toEqual([]);
  });

  it("does not treat a following 'total compensation may include' sentence as total comp", () => {
    const [r] = parseTextPay("The estimated salary range for this position is $135,000 - $200,000/year. Total compensation for this position may also include restricted stock units.");
    expect(r?.basis).toBe("base");
  });

  it("labels OTE figures as OTE, not base", () => {
    expect(parseTextPay("OTE: $200,000 - $260,000")[0]?.basis).toBe("ote");
    expect(parseTextPay("Compensation: $200K - $260K OTE")[0]?.basis).toBe("ote");
  });

  it("labels total compensation as total", () => {
    expect(parseTextPay("Total compensation range: $180,000 - $250,000 including equity")[0]?.basis).toBe("total");
  });

  it("handles single figures only when introduced as pay", () => {
    expect(parseTextPay("Base salary starting at $155,000.")[0]).toMatchObject({ min: 155000, max: 155000 });
    expect(parseTextPay("Salary up to $130,000.")[0]).toMatchObject({ min: null, max: 130000 });
  });
});

describe("compensation evaluation", () => {
  it("passes when base max meets the minimum", () => {
    expect(ev("Base salary: $120,000 - $150,000").verdict).toBe("pass");
  });

  it("fails when base max is below the minimum", () => {
    const r = ev("Base salary: $100,000 - $130,000");
    expect(r.verdict).toBe("fail");
    expect(r.reason).toMatch(/below minimum/);
  });

  it("missing compensation is UNKNOWN_COMP and never invented", () => {
    const r = ev("We offer competitive pay and great benefits.");
    expect(r).toMatchObject({ status: "UNKNOWN_COMP", verdict: "unknown", baseMax: null, baseMin: null, ranges: [] });
  });

  it("never treats OTE or total comp as base", () => {
    const r = ev("OTE: $180,000 - $240,000");
    expect(r.status).toBe("NON_BASE_ONLY");
    expect(r.baseMax).toBeNull();
    expect(r.verdict).toBe("unknown");
  });

  it("fails when even non-base pay tops out below the minimum base", () => {
    expect(ev("Total compensation: $100,000 - $130,000").verdict).toBe("fail");
  });

  it("uses structured pay first and keeps the sales-roles OTE blurb from mislabeling engineering pay", () => {
    const r = evaluateComp(
      {
        title: "Software Engineer",
        structuredPay: [{ min: 190000, max: 230000, currency: "USD", interval: "year", label: "Annual Salary: For sales roles, the range provided is the role's On Target Earnings (OTE) range", source: "greenhouse.pay_input_ranges" }],
        descriptionText: "",
      },
      C,
    );
    expect(r).toMatchObject({ status: "BASE_KNOWN", verdict: "pass", baseMax: 230000 });
    const sales = evaluateComp({ title: "Account Executive", structuredPay: [{ min: 190000, max: 230000, currency: "USD", interval: "year", label: "For sales roles, the range provided is OTE", source: "x" }], descriptionText: "" }, C);
    expect(sales.status).toBe("NON_BASE_ONLY");
  });

  it("treats non-USD only pay as unknown", () => {
    const r = evaluateComp({ title: "SWE", structuredPay: [{ min: 90000, max: 120000, currency: "GBP", interval: "year", source: "x" }], descriptionText: "" }, C);
    expect(r.status).toBe("UNKNOWN_COMP");
  });
});
