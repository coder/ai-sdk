# coder/ai-sdk

**Coder integrations for the [Vercel AI SDK](https://ai-sdk.dev).** Run coding
agents inside Coder workspaces, drive Coder Agents from AI SDK code, and call
models through your deployment's AI Gateway.

> [!NOTE]
> All packages are pre-1.0. Expect breaking changes.

## Packages

| Package                                         | Version                                                                                                                 | Use it to…                                                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@coder/ai-sdk-provider`](./packages/provider) | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-provider.svg)](https://www.npmjs.com/package/@coder/ai-sdk-provider) | Call models with `generateText` / `streamText` through [AI Gateway](https://coder.com/docs/ai-coder/ai-gateway). One Coder token, no raw provider keys, per-user auth and audit. |
| [`@coder/ai-sdk-agent`](./packages/agent)       | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-agent.svg)](https://www.npmjs.com/package/@coder/ai-sdk-agent)       | Run **Coder Agents**, Coder's server-side agent runtime, as a real AI SDK v7 `Agent` (`generate()`, `stream()`, tool calls).                                                     |
| [`@coder/ai-sdk-sandbox`](./packages/sandbox)   | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-sandbox.svg)](https://www.npmjs.com/package/@coder/ai-sdk-sandbox)   | Run CLI coding agents (Claude Code, Codex) under the AI SDK v7 `HarnessAgent` in an isolated **Coder workspace**, with your tools, secrets, and network.                         |

Each package ships on npm independently, with its own README.
[`@coder/ai-sdk-effect`](./packages/effect) is an unpublished, experimental
[Effect](https://effect.website) bridge ([#144](https://github.com/coder/ai-sdk/issues/144)).

### Which package?

| You need…                                                                 | Use                      |
| ------------------------------------------------------------------------- | ------------------------ |
| A **model**: text, streaming, or schema-constrained structured output     | `@coder/ai-sdk-provider` |
| Coder's **server-side agent**: multi-step tool loop, MCP, workspace tools | `@coder/ai-sdk-agent`    |
| A **CLI coding agent** (Claude Code, Codex) inside a workspace            | `@coder/ai-sdk-sandbox`  |

## Using them together

The packages are independent, but they compose against one deployment with one
Coder token. This example audits a project's dependencies:

1. **Sandbox** provisions a workspace.
2. **Agent** works inside it and calls one custom tool that runs in _your_
   process.
3. **Provider** turns the agent's prose report into a typed object.

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

// The transport and the agent read CODER_URL + CODER_SESSION_TOKEN by default
// (explicit `url`/`baseUrl` and `token` options also exist).

// 1. Sandbox: get-or-create a workspace and wait until its agent is ready.
//    The native transport talks straight to your deployment (no `coder` CLI
//    or `ssh` on the host). Assumes the template checks out your project.
const transport = new CoderNativeTransport();
const ws = await ensureCoderWorkspace({
  workspace: "dep-audit",
  create: { template: "docker" },
  transport,
});
if (ws.id === undefined) throw new Error("transport did not report a workspace id");

// 2. Agent: the server runs the loop and its file/shell tools; your custom
//    tool executes here, and its result is sent back.
const agent = new CoderAgent({
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

// 3. Provider: schema-constrained extraction through AI Gateway. The provider
//    takes explicit credentials (its `apiKey` is dual-purpose in BYOK mode).
const coder = createCoder({
  baseURL: process.env.CODER_URL!,
  apiKey: process.env.CODER_SESSION_TOKEN!,
});
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

Each step stands alone; skip the ones you don't need.

### Go deeper

- **Sandbox:** [`ensureCoderWorkspace` and create settings](./packages/sandbox/README.md#provisioning-a-workspace-without-a-session)
- **Agent:** [custom tools](./packages/agent/README.md#custom-tools) ·
  [structured output](./packages/agent/README.md#structured-output) (typed
  answer from the agent run itself, no follow-up model call)
- **Agent guides:** [workspaces & quota](./packages/agent/docs/workspaces-and-quota.md)
  (fleet sizing, autostop, stuck turns) ·
  [durable workflows](./packages/agent/docs/durable-workflows.md) (persist
  `chatId` across jobs, recover from drops and timeouts)
- **Provider:** [named providers and auth modes](./packages/provider/README.md#named-providers-and-the-two-wire-protocols) ·
  [enterprise governance & security](./packages/provider/README.md#enterprise-governance--security)
  (data flow, credential isolation, audit, permissions)

## Contributing

With [mise](https://mise.jdx.dev) installed:

```bash
mise install && pnpm install   # toolchain + dependencies
pnpm check && pnpm test        # format check, lint, typecheck, then test
```

Setup, commands, and releases: [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[Apache-2.0](./LICENSE) © Coder Technologies, Inc.
