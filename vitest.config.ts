import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Live network tests are opt-in: CAS_LIVE_SMOKE=1 npm test
    testTimeout: 20000,
  },
});
