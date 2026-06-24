# coder/ai-sdk

**Coder's integrations with the [Vercel AI SDK](https://ai-sdk.dev).** Run coding
agents inside Coder workspaces, and drive Coder Agents from AI SDK code.

> [!NOTE]
> All three packages are pre-1.0 and track experimental upstreams (the AI SDK
> harness is on `canary`; Coder's chat API is experimental). Expect breaking
> changes.

## Packages

Each package is published to npm independently and ships its own README with full
install instructions, usage, and API docs.

| Package                                         | Version                                                                                                                 | What it does                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@coder/ai-sdk-sandbox`](./packages/sandbox)   | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-sandbox.svg)](https://www.npmjs.com/package/@coder/ai-sdk-sandbox)   | A **sandbox provider** for the Vercel AI SDK v7 `HarnessAgent`. Runs CLI coding agents — Claude Code, Codex — inside a **Coder workspace** instead of on the local machine, so each agent gets a real, isolated dev environment with your tools, secrets, and network.                                       |
| [`@coder/ai-sdk-agent`](./packages/agent)       | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-agent.svg)](https://www.npmjs.com/package/@coder/ai-sdk-agent)       | A Vercel AI SDK–compliant **`Agent`** (AI SDK v6) backed by **Coder Agents**, Coder's server-side agent runtime. `new CoderAgent()` returns a real `Agent` — `generate()`, `stream()`, tool calls, the whole interface.                                                                                      |
| [`@coder/ai-sdk-provider`](./packages/provider) | [![npm](https://img.shields.io/npm/v/@coder/ai-sdk-provider.svg)](https://www.npmjs.com/package/@coder/ai-sdk-provider) | A **Vercel AI SDK provider** that routes `generateText` / `streamText` calls through your Coder deployment's [AI Gateway](https://coder.com/docs/ai-coder/ai-gateway). Point it at your deployment with a Coder API token and use any model it proxies — no raw provider keys, with per-user auth and audit. |

**Which package?** Need a **model** (text, streaming, or schema‑constrained
structured output) through your deployment → `@coder/ai-sdk-provider`. Need Coder's
**server‑side agent** (multi‑step tool loop, MCP, workspace file/shell tools) →
`@coder/ai-sdk-agent`. Need to run a **CLI coding agent** (Claude Code, Codex)
inside a workspace → `@coder/ai-sdk-sandbox`.

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
