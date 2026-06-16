import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests are fast and hermetic; e2e tests hit a live Coder deployment
    // and are run explicitly via `pnpm test:e2e`.
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
