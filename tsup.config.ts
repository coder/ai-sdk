import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // `ws` is the only runtime dependency we bundle-exclude; `ai`/`zod` are peers.
  external: ["ai", "zod", "ws", "@ai-sdk/react"],
});
