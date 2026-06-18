// Shared setup for the examples: reads Coder connection details from the
// environment.
//
// In a real project you'd import from the package:  import { createCoder } from "@coder/ai-sdk-provider";
// Here the examples import from "../src/index.js" so they run straight against
// the source via `tsx`.

export interface ExampleEnv {
  baseURL: string;
  apiKey: string;
  model: string;
}

export function loadEnv(): ExampleEnv {
  const baseURL = (process.env.CODER_URL ?? "https://dev.coder.com").replace(/\/$/, "");
  const apiKey = process.env.CODER_API_TOKEN ?? process.env.CODER_SESSION_TOKEN ?? "";

  if (!apiKey) {
    console.error(
      [
        "",
        "This example needs Coder credentials. Set:",
        "",
        `  export CODER_URL=${baseURL}`,
        "  export CODER_API_TOKEN=$(coder tokens create --name ai-sdk-provider-example)",
        "",
        "Optional:",
        "  export CODER_MODEL=claude-sonnet-4-6   # any model id your deployment proxies",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  return { baseURL, apiKey, model: process.env.CODER_MODEL ?? "claude-sonnet-4-6" };
}

/** Print a heading so example output is easy to read. */
export function heading(title: string): void {
  console.log(`\n\x1b[1m\x1b[36m=== ${title} ===\x1b[0m`);
}
