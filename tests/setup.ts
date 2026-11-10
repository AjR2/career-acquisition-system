import { assertDbAllowed } from "../src/config/env.js";

// Tests always run against an isolated database.
process.env.CAS_ENV = "test";
if (process.env.CAS_DB_PATH && process.env.CAS_DB_PATH !== ":memory:") {
  // Throws if the configured path is the production database.
  assertDbAllowed({ CAS_ENV: "test" }, process.env.CAS_DB_PATH);
}
process.env.CAS_DB_PATH = ":memory:";
