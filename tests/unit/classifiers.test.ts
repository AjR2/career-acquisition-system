import { describe, expect, it } from "vitest";
import { classifyClearance, classifyEmployment, classifyRole, detectAiPolicy } from "../../src/eligibility/classifiers.js";
import { cfg } from "../helpers.js";

describe("employment type", () => {
  const e = (title: string, raw: string | null = null, text = "") => classifyEmployment({ title, employmentTypeRaw: raw, descriptionText: text }).type;
  it("reads ATS fields", () => {
    expect(e("SWE", "FullTime")).toBe("FULL_TIME");
    expect(e("SWE", "Full-time")).toBe("FULL_TIME");
    expect(e("SWE", "Contract")).toBe("CONTRACT");
    expect(e("SWE", "Fixed-Term")).toBe("CONTRACT");
    expect(e("SWE", "PartTime")).toBe("PART_TIME");
    expect(e("SWE", "Intern")).toBe("INTERNSHIP");
  });
  it("detects contract-to-hire separately from contract", () => {
    expect(e("Software Engineer (Contract-to-Hire)")).toBe("CONTRACT_TO_HIRE");
    expect(e("SWE", "Contract", "This is a 6-month contract-to-hire engagement.")).toBe("CONTRACT_TO_HIRE");
    expect(e("Software Engineer (Contract)")).toBe("CONTRACT");
    expect(e("SWE", null, "This is a 6-month contract role.")).toBe("CONTRACT");
  });
  it("leaves unknown when nothing is stated", () => {
    expect(e("Software Engineer")).toBe("UNKNOWN");
  });
});

describe("security clearance", () => {
  it.each([
    "Active TS/SCI clearance required.",
    "Must hold an active Secret clearance.",
    "What We Require - Active Top Secret Clearance",
    "Requires an active security clearance.",
    "Candidates must possess a current DoD clearance.",
    "Full scope poly required.",
  ])("REQUIRED: %s", (t) => expect(classifyClearance(t).status).toBe("REQUIRED"));

  it.each([
    "Must be able to obtain a US security clearance.",
    "Eligibility to obtain and maintain a Secret clearance is required.",
    "We will sponsor your security clearance.",
    "Candidates must be clearable.",
  ])("SPONSORSHIP_AVAILABLE: %s", (t) => expect(classifyClearance(t).status).toBe("SPONSORSHIP_AVAILABLE"));

  it("an active clearance plus eligibility for an SCI upgrade is still REQUIRED", () => {
    expect(classifyClearance("Active Top Secret clearance with eligibility and willingness to obtain SCI access.").status).toBe("REQUIRED");
  });

  it.each(["An active security clearance is a plus.", "Security clearance preferred.", "Bonus points: active Secret clearance (nice to have)."])("PREFERRED: %s", (t) =>
    expect(classifyClearance(t).status).toBe("PREFERRED"),
  );

  it("background-check language is never clearance language", () => {
    expect(classifyClearance("Offers are contingent on passing a background check.").status).toBe("NONE_MENTIONED");
    expect(classifyClearance("You must pass a pre-employment background check and drug screen.").status).toBe("NONE_MENTIONED");
  });

  it("records citizenship requirements separately", () => {
    const r = classifyClearance("Due to ITAR, applicants must be a U.S. citizen.");
    expect(r.status).toBe("NONE_MENTIONED");
    expect(r.citizenshipRequired).toBeTruthy();
  });
});

describe("employer AI-use policy detection", () => {
  it("detects an AI policy application question", () => {
    const r = detectAiPolicy({ aiDisclaimer: null, descriptionText: "", questions: [{ label: "AI Policy for Application", required: true, fieldTypes: ["multi_value_single_select"], options: ["Yes"] }] });
    expect(r.detected).toBe(true);
    expect(r.text).toMatch(/AI Policy for Application/);
  });
  it("detects posting text that asks candidates not to use AI", () => {
    expect(detectAiPolicy({ aiDisclaimer: null, questions: null, descriptionText: "Please do not use AI tools to write your application answers." }).detected).toBe(true);
  });
  it("detects the Greenhouse AI disclaimer", () => {
    expect(detectAiPolicy({ aiDisclaimer: "We review applications without AI-generated responses.", questions: null, descriptionText: "" }).detected).toBe(true);
  });
  it("does not fire on questions about AI experience or on AI company descriptions", () => {
    const r = detectAiPolicy({
      aiDisclaimer: null,
      descriptionText: "We build AI agents and use LLMs to help customers. Experience with generative AI is a plus.",
      questions: [{ label: "Describe a project where you used LLMs to help users", required: false, fieldTypes: ["textarea"] }],
    });
    expect(r.detected).toBe(false);
  });
});

describe("role family", () => {
  it.each(["Software Engineer, AI Products", "AI-Native Product Engineer", "Forward Deployed AI Engineer", "Full-Stack Engineer", "Applied AI Engineer", "Agent Platform Engineer", "AI Solutions Engineer", "Member of Technical Staff"])(
    "accepts %s",
    (t) => expect(classifyRole(t, cfg.roles).ok).toBe(true),
  );
  it.each(["Engineering Manager, Agents", "Software Engineering Intern", "Sales Engineer", "Account Executive", "Recruiter", "Developer Relations", "Hardware Engineer", "Security Engineer", "Product Designer", "Chief of Staff, Public Sector Engineering", "Customer Success Engineer", "Engineering Program Lead", "Product Designer, Claude Developer Platform"])(
    "rejects %s",
    (t) => expect(classifyRole(t, cfg.roles).ok).toBe(false),
  );
});
