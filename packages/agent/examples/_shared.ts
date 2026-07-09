// Shared setup for the examples: reads Coder connection details from the
// environment and (if needed) auto-detects your organization.
//
// In a real project you'd import from the package:  import { CoderAgent } from "@coder/ai-sdk-agent";
// Here the examples import from "../src/index.js" so they run straight against
// the source via `tsx`.

export interface ExampleEnv {
  baseUrl: string;
  token: string;
  organizationId: string;
  model: string;
  /** Model for tool-calling examples (03, 06) — stronger default, own override. */
  toolModel: string;
}

export async function loadEnv(): Promise<ExampleEnv> {
  const baseUrl = (process.env.CODER_URL ?? "https://dev.coder.com").replace(/\/$/, "");
  const token = process.env.CODER_SESSION_TOKEN ?? "";

  if (!token) {
    console.error(
      [
        "",
        "This example needs Coder credentials. Set:",
        "",
        `  export CODER_URL=${baseUrl}`,
        "  export CODER_SESSION_TOKEN=$(coder tokens create --name coderagent-example)",
        "",
        "Optional:",
        "  export CODER_ORG_ID=<org-uuid>   # otherwise auto-detected from your user",
        "  export CODER_MODEL=haiku         # model hint (display name, provider:model, or UUID)",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  let organizationId = process.env.CODER_ORG_ID ?? "";
  if (!organizationId) {
    const res = await fetch(`${baseUrl}/api/v2/users/me`, {
      headers: { "Coder-Session-Token": token },
    });
    if (!res.ok) {
      console.error(
        `Failed to look up your Coder user (HTTP ${res.status}). Check CODER_URL and CODER_SESSION_TOKEN.`,
      );
      process.exit(1);
    }
    const me = (await res.json()) as { organization_ids?: string[] };
    const first = me.organization_ids?.[0];
    if (!first) {
      console.error("Could not determine your organization. Set CODER_ORG_ID explicitly.");
      process.exit(1);
    }
    organizationId = first;
  }

  return {
    baseUrl,
    token,
    organizationId,
    // `||`, not `??`: a set-but-empty env var should fall back too.
    model: process.env.CODER_MODEL || "haiku",
    toolModel: process.env.CODER_TOOL_MODEL || "sonnet",
  };
}

/** Print a heading so example output is easy to read. */
export function heading(title: string): void {
  console.log(`\n[1m[36m=== ${title} ===[0m`);
}
