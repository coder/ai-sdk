# Template authoring: zero-install sessions

Build a Coder template whose workspaces start harness sessions with **zero
runtime install latency**. A validated Dockerfile + `main.tf` pair lives in
[`examples/template/`](../examples/template/).

This guide covers only the ai-sdk-specific delta. For generic template
authoring, see the [Coder template docs](https://coder.com/docs/admin/templates)
and [Coder's example Docker template](https://github.com/coder/coder/tree/main/examples/templates/docker).

## What the first session installs

On the first session in a fresh workspace, the Claude Code adapter applies its
bootstrap recipe relative to the session's default working directory (`$HOME`
for this provider):

1. Writes `package.json`, `pnpm-lock.yaml`, and `bridge.mjs` (assets shipped
   inside `@ai-sdk/harness-claude-code`) to `~/.harness-bootstrap/claude-code/`.
2. Runs `pnpm install --frozen-lockfile --store-dir .pnpm-store` there. This is
   the expensive step: ~300 MB from the npm registry (the bridge dependencies
   include the `@anthropic-ai/claude-code` platform binary), taking tens of
   seconds to minutes depending on the network.
3. Runs the CLI's `install.cjs` (links the platform binary npm delivered; no
   extra download) and `./node_modules/.bin/claude --version`.
4. Writes a `.bootstrap-<recipe-hash>.ok` marker next to them. Later sessions
   see the marker and skip all of the above: a single file read.

Zero-install means baking the results of steps 1–3 into the image **at that
exact path**. The first session in each workspace then replays the recipe as a
fast offline no-op (~4 s measured; pnpm prints `Already up to date` and
downloads nothing) and writes the marker. Every later session is a single file
read.

## Step 1 — Dockerfile: pre-bake the bootstrap

[`examples/template/Dockerfile`](../examples/template/Dockerfile) installs the
[workspace requirements](../README.md#workspace-requirements) (Node 24 + pnpm on
PATH, bash/coreutils) and replays the recipe at build time: same files, same
commands, same absolute path.

```dockerfile
ARG HARNESS_CLAUDE_CODE_VERSION=1.0.90
RUN mkdir -p /home/${USER}/.harness-bootstrap/claude-code \
  && cd /tmp \
  && npm pack @ai-sdk/harness-claude-code@${HARNESS_CLAUDE_CODE_VERSION} \
  && tar -xzf ai-sdk-harness-claude-code-${HARNESS_CLAUDE_CODE_VERSION}.tgz \
  && cp package/dist/bridge/package.json package/dist/bridge/pnpm-lock.yaml \
    /home/${USER}/.harness-bootstrap/claude-code/ \
  && cp package/dist/bridge/index.mjs \
    /home/${USER}/.harness-bootstrap/claude-code/bridge.mjs \
  && rm -rf package ai-sdk-harness-claude-code-${HARNESS_CLAUDE_CODE_VERSION}.tgz \
  && cd /home/${USER}/.harness-bootstrap/claude-code \
  && pnpm install --frozen-lockfile --store-dir .pnpm-store \
  && node node_modules/@anthropic-ai/claude-code/install.cjs \
  && ./node_modules/.bin/claude --version
```

Rules that make or break the pre-bake:

- **Bake at the final absolute path.** pnpm records the store location as an
  absolute path (in `node_modules/.modules.yaml`). A cache baked at, say,
  `/opt/...` and copied into `$HOME` later makes the session's `pnpm install`
  abort with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`: pnpm wants to purge
  and reinstall, and a session has no TTY to confirm.
- **Pin the adapter version your application resolves.** Find it with
  `pnpm why @ai-sdk/harness-claude-code` (or in your lockfile) and pass it as
  `--build-arg HARNESS_CLAUDE_CODE_VERSION=...`. The recipe and its marker hash
  derive from the adapter's shipped assets. A mismatch is not fatal (the recipe
  re-runs in the same directory and downloads only the delta), but it
  reintroduces registry traffic on first sessions.
- **Build for the workspace CPU architecture.** The pre-bake fetches the builder
  platform's `claude` binary.

## Step 2 — main.tf: get the cache into the home volume

[`examples/template/main.tf`](../examples/template/main.tf) is Coder's example
Docker template minus the IDE modules, with three ai-sdk-specific choices:

- **The workspace image is the pre-baked one** (`variable "image"`). Push it to
  a registry your Coder provisioners can pull from.
- **`startup_script_behavior = "blocking"`** on `coder_agent`. This provider's
  create mode waits for `lifecycle_state: ready` before the harness runs, and
  blocking makes ready mean "startup script finished". The attribute defaults to
  `non-blocking`, in which case ready does not wait for the script.
- **The home volume seeds itself from the image.** Docker populates a fresh
  (empty) named volume with the image's content at the mount path, so
  `/home/coder/.harness-bootstrap` lands in every new workspace's volume with no
  startup-script copying.

No port configuration is needed: the provider forwards the bridge port itself
(OpenSSH `-L` or the native relay), not through template port shares.

<details>
<summary>Volumes that don't copy image content (e.g. a Kubernetes PVC)</summary>

A Kubernetes PVC mounted at `/home/coder` shadows it with an empty filesystem.
Stash the bake outside the mount and restore it, at the same absolute path, on
first start:

```dockerfile
# Dockerfile, after the pre-bake step:
RUN sudo cp -a /home/${USER}/.harness-bootstrap /opt/harness-bootstrap-stash
```

```hcl
  startup_script = <<-EOT
    set -e
    if [ ! -d ~/.harness-bootstrap ]; then
      cp -a /opt/harness-bootstrap-stash ~/.harness-bootstrap
    fi
  EOT
```

`cp -a` preserves the hardlinks between the pnpm store and `node_modules`, so
the stash and the restore each stay ~300 MB rather than doubling.

</details>

Build, push, and point the provider at the template
([creating templates](https://coder.com/docs/admin/templates/creating-templates)):

```bash
cd examples/template
docker build -t <registry>/ai-sdk-sandbox-workspace:v1 .
docker push <registry>/ai-sdk-sandbox-workspace:v1
coder templates push ai-sdk-sandbox --variable image=<registry>/ai-sdk-sandbox-workspace:v1
```

```ts
createCoderWorkspace({ create: { template: "ai-sdk-sandbox" } });
```

## Sizing

Measured on the example image (linux/amd64):

| Component                     | Size    |
| ----------------------------- | ------- |
| Ubuntu 24.04 + Node 24 + pnpm | ~430 MB |
| Bootstrap cache               | ~300 MB |
| **Total image**               | ~730 MB |

The cache is dominated by the pnpm store; `node_modules` hardlinks into it.
Each workspace's home volume receives the ~300 MB seeded cache. Leave headroom
for per-session work directories (`claude-code-<sessionId>/`) and whatever your
agents check out.

## Verifying zero installs

**Image-level (no Coder deployment needed).** Replay the bootstrap on a fresh
volume with networking disabled. It must succeed offline:

```bash
docker volume rm -f probe-home && docker volume create probe-home
docker run --rm --network none -v probe-home:/home/coder \
  <image> bash -lc 'cd ~/.harness-bootstrap/claude-code \
    && pnpm install --frozen-lockfile --store-dir .pnpm-store \
    && node node_modules/@anthropic-ai/claude-code/install.cjs \
    && ./node_modules/.bin/claude --version'
```

Expect `Already up to date` from pnpm and the CLI version banner within a few
seconds. That proves a session's bootstrap needs no registry access.

**Session-level.** After the first session against a workspace from the
template, `~/.harness-bootstrap/claude-code/` must contain a `.bootstrap-*.ok`
marker (later sessions skip the recipe entirely). If session creation instead
stalls for minutes with pnpm download progress in the bootstrap, the image's
pinned adapter version doesn't match the application's (see the pinning rule
above).
