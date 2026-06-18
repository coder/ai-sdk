# coder/ai-sdk

**Coder's integrations with the [Vercel AI SDK](https://ai-sdk.dev).** Run coding
agents inside Coder workspaces, and drive Coder's server-side agent runtime from
AI SDK code — two small, focused packages in one monorepo.

> [!NOTE]
> Both packages are pre-1.0 and track experimental upstreams (the AI SDK harness
> is on `canary`; Coder's chat API is experimental). Expect breaking changes.

## Packages

Each package is published to npm independently and ships its own README with full
install instructions, usage, and API docs.

### [`@coder/ai-sdk-sandbox`](./packages/sandbox)

[![npm](https://img.shields.io/npm/v/@coder/ai-sdk-sandbox.svg)](https://www.npmjs.com/package/@coder/ai-sdk-sandbox)

A **sandbox provider** for the Vercel AI SDK v7 `HarnessAgent`. It runs CLI coding
agents — Claude Code, Codex — inside a **Coder workspace** instead of on the local
machine, so each agent gets a real, isolated dev environment with your tools,
secrets, and network.

### [`@coder/ai-sdk-agent`](./packages/agent)

[![npm](https://img.shields.io/npm/v/@coder/ai-sdk-agent.svg)](https://www.npmjs.com/package/@coder/ai-sdk-agent)

A Vercel AI SDK–compliant **`Agent`** (AI SDK v6) backed by **Coder Agents**,
Coder's server-side agent runtime. `new CoderAgent()` returns a real `Agent` —
`generate()`, `stream()`, tool calls, the whole interface.

## Repository layout

```text
packages/
  sandbox/   @coder/ai-sdk-sandbox   — Vercel AI SDK v7 (@ai-sdk/harness)
  agent/     @coder/ai-sdk-agent     — Vercel AI SDK v6 (ai)
```

The two deliberately target different AI SDK generations. pnpm keeps their
dependency trees isolated, so they coexist without forcing a single `ai` version.

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
