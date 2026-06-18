import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests are fast and hermetic. The e2e test hits the live Anthropic
    // API and is gated on ANTHROPIC_API_KEY; run it explicitly via `test:e2e`.
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
