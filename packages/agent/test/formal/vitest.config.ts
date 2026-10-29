import { defineConfig } from "vitest/config";

// The bounded exhaustive checks. They are not part of `pnpm test`: run them
// with `.agents/skills/verify-agent-stream-exactly-once/check.sh`.
export default defineConfig({
  test: {
    include: ["test/formal/**/*.check.ts"],
    testTimeout: 600_000,
  },
});
