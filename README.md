# coder/ai-sdk

**Coder's integrations with the [Vercel AI SDK](https://ai-sdk.dev).** Run coding
agents inside Coder workspaces, and drive Coder Agents from AI SDK code.

> [!NOTE]
> All three packages are pre-1.0 and track experimental upstreams (Coder's
> chat API is experimental). Expect breaking changes.

## Packages

Each package is published to npm independently and ships its own README with full
install instructions, usage, and API docs.

| Package                                         | Version                                                                                                                 | What it does                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@coder/ai-sdk-sandbox`](./packages/sandbox)   | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-sandbox.svg)](https://www.npmjs.com/package/@coder/ai-sdk-sandbox)   | A **sandbox provider** for the Vercel AI SDK v7 `HarnessAgent`. Runs CLI coding agents — Claude Code, Codex — inside a **Coder workspace** instead of on the local machine, so each agent gets a real, isolated dev environment with your tools, secrets, and network.                                       |
| [`@coder/ai-sdk-agent`](./packages/agent)       | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-agent.svg)](https://www.npmjs.com/package/@coder/ai-sdk-agent)       | A Vercel AI SDK–compliant **`Agent`** (AI SDK v7) backed by **Coder Agents**, Coder's server-side agent runtime. `new CoderAgent()` returns a real `Agent` — `generate()`, `stream()`, tool calls, the whole interface.                                                                                      |
| [`@coder/ai-sdk-provider`](./packages/provider) | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-provider.svg)](https://www.npmjs.com/package/@coder/ai-sdk-provider) | A **Vercel AI SDK provider** that routes `generateText` / `streamText` calls through your Coder deployment's [AI Gateway](https://coder.com/docs/ai-coder/ai-gateway). Point it at your deployment with a Coder API token and use any model it proxies — no raw provider keys, with per-user auth and audit. |

**Which package?** Need a **model** (text, streaming, or schema‑constrained
structured output) through your deployment → `@coder/ai-sdk-provider`. Need Coder's
**server‑side agent** (multi‑step tool loop, MCP, workspace file/shell tools) →
`@coder/ai-sdk-agent`. Need to run a **CLI coding agent** (Claude Code, Codex)
inside a workspace → `@coder/ai-sdk-sandbox`.

## Using them together

The packages are independent, but they compose into one application against one
deployment, authenticated by one Coder token: **provision** a workspace with the
sandbox package, **drive** Coder's server-side agent in it with the agent
package, then **extract** a typed result with the provider. The full flow below
audits a project's dependencies — the agent works inside the workspace (calling
one custom tool that executes in _your_ process), and the provider parses the
prose report into a typed object through AI Gateway.

```bash
pnpm add @coder/ai-sdk-sandbox @coder/ai-sdk-agent @coder/ai-sdk-provider ai zod
pnpm add @ai-sdk/harness @ai-sdk/provider-utils   # peer dependencies of the sandbox package

export CODER_URL=https://coder.example.com
export CODER_SESSION_TOKEN=$(coder tokens create --name compose-example)
export CODER_ORG_ID=<org-uuid>   # e.g. the first `organization_ids` entry from /api/v2/users/me
```

```ts
import { generateObject, tool } from "ai";
import { z } from "zod";
import { CoderNativeTransport, ensureCoderWorkspace } from "@coder/ai-sdk-sandbox";
import { CoderAgent } from "@coder/ai-sdk-agent";
import { createCoder } from "@coder/ai-sdk-provider";

const baseUrl = process.env.CODER_URL!; // e.g. https://coder.example.com
const token = process.env.CODER_SESSION_TOKEN!;

// 1. Sandbox: get-or-create a workspace and wait until its agent is ready.
//    The native transport talks straight to your deployment — no `coder` CLI
//    or `ssh` on the host. Assumes the template checks out your project.
const transport = new CoderNativeTransport({ url: baseUrl, token });
const ws = await ensureCoderWorkspace({
  workspace: "dep-audit",
  create: { template: "docker" },
  transport,
});
if (ws.id === undefined) throw new Error("transport did not report a workspace id");

// 2. Agent: drive Coder's server-side agent loop in that workspace. The
//    server runs the multi-step loop and its file/shell tools; your custom
//    tool executes here, in this process, and its result is sent back.
const agent = new CoderAgent({
  baseUrl,
  token,
  organizationId: process.env.CODER_ORG_ID!,
  model: "claude-sonnet-4-6",
  workspaceId: ws.id, // binds the chat's workspace-scoped tools
  instructions: "Audit the project in the workspace. Use latestVersion to check dependencies.",
  tools: {
    latestVersion: tool({
      description: "Look up the latest published version of an npm package.",
      inputSchema: z.object({ pkg: z.string() }),
      execute: async ({ pkg }) => {
        const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`);
        if (!res.ok) return { pkg, error: `registry returned ${res.status}` };
        const { version } = (await res.json()) as { version: string };
        return { pkg, version };
      },
    }),
  },
});

let report: string;
try {
  const result = await agent.generate({
    prompt:
      "Read package.json, compare the dependencies against their latest versions, and report on the project's dependency health.",
  });
  report = result.text;
} finally {
  await agent.archive(); // archives the chat; never deletes the workspace
}

// 3. Provider: schema-constrained extraction through AI Gateway.
const coder = createCoder({ baseURL: baseUrl, apiKey: token });
const { object: audit } = await generateObject({
  model: coder("claude-sonnet-4-6"),
  schema: z.object({
    health: z.enum(["good", "aging", "at-risk"]),
    outdated: z.array(z.object({ pkg: z.string(), current: z.string(), latest: z.string() })),
    summary: z.string(),
  }),
  prompt: `Extract the dependency audit from this report:\n\n${report}`,
});

console.log(audit.health, audit.summary);
console.table(audit.outdated);

await transport.close(); // close cached relay WebSockets on shutdown
```

Each step stands alone — skip the ones you don't need. For depth on each:
[`ensureCoderWorkspace` and workspace creation settings](./packages/sandbox/README.md#provisioning-a-workspace-without-a-session)
in the sandbox README; [custom tools](./packages/agent/README.md#custom-tools),
[structured output](./packages/agent/README.md#structured-output) (when the
typed answer must come out of the agent run itself, not a follow-up model call),
and the [workspaces & quota operations guide](./packages/agent/README.md#workspaces--quota)
(fleet sizing, autostop, troubleshooting stuck turns)
in the agent README;
[surfaces and authentication modes](./packages/provider/README.md#the-two-surfaces)
and the [enterprise governance & security reference](./packages/provider/README.md#enterprise-governance--security)
(data flow, credential isolation, audit capture, required permissions)
in the provider README.

## Contributing

Development setup, the command reference, and how releases work all live in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). The short version — with
[mise](https://mise.jdx.dev) installed:

```bash
mise install && pnpm install   # set up the toolchain + dependencies
pnpm check && pnpm test        # format check, lint, typecheck, then test
```

## License

[Apache-2.0](./LICENSE) © Coder Technologies, Inc.
