import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests are fast and hermetic (no live deployment). They assert the
    // URLs/headers the provider builds by stubbing `fetch`.
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
