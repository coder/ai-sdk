# examples/template

## Overview

A sample Coder template for `@coder/ai-sdk-sandbox` workspaces. `main.tf` is a trimmed
variant of Coder's example Docker template. `Dockerfile` builds a workspace image that
pre-bakes the Claude Code bridge bootstrap, so a session's first bootstrap downloads
nothing when the adapter versions match. The full guide is
[template-authoring.md](../../docs/template-authoring.md).

## Interface

- Required providers `coder/coder` and `kreuzwerker/docker`, with no version
  constraints. [main.tf:terraform]
- Variable `docker_socket`: `string`, default `""`, "(Optional) Docker socket URI".
  The `docker` provider uses it as `host` only when it is not empty.
  [main.tf:variable.docker_socket]
- Variable `image`: `string`, default `"ai-sdk-sandbox-workspace:latest"`. The comment
  says to build the image from the `Dockerfile` next to `main.tf` and push it to a
  registry that the provisioners can pull from. [main.tf:variable.image]
- Data sources `coder_provisioner.me`, `coder_workspace.me`, `coder_workspace_owner.me`.
  [main.tf:data.coder_workspace.me]
- `coder_agent.main`: `os = "linux"`, `arch` from the provisioner,
  `startup_script_behavior = "blocking"`. [main.tf:resource.coder_agent.main]
- `docker_image.workspace`, `docker_volume.home_volume`, `docker_container.workspace`.
  [main.tf:resource.docker_container.workspace]
- Image base `ubuntu:24.04` with `ca-certificates curl git sudo`, Node.js from the
  NodeSource `setup_24.x` script, and `pnpm@10`. [Dockerfile:FROM]
- Build arg `USER`, default `coder`. [Dockerfile:USER]
- Build arg `HARNESS_CLAUDE_CODE_VERSION`, default `1.0.90`. The comment says to pin it to
  the adapter version that the host application resolves.
  [Dockerfile:HARNESS_CLAUDE_CODE_VERSION]

## Invariants

- The agent's `ready` lifecycle state waits for the startup script, because
  `startup_script_behavior` is `"blocking"`. The comment says that `createCoderWorkspace`
  create mode and `ensureCoderWorkspace` wait for `ready`. [main.tf:resource.coder_agent.main]
- The startup script runs with `set -e`. It copies `/etc/skel` into the home folder only
  when `~/.init_done` does not exist. [main.tf:resource.coder_agent.main]
- The container `count` is `data.coder_workspace.me.start_count`, so the container exists
  only while the workspace is started. [main.tf:resource.docker_container.workspace]
- The home volume has `lifecycle { ignore_changes = all }`, so attribute changes do not
  replace it. [main.tf:resource.docker_volume.home_volume]
- `keep_locally = true`: deleting a workspace does not remove the shared image.
  [main.tf:resource.docker_image.workspace]
- The home volume mounts at `/home/coder`, read-write. The comment says no bridge port
  configuration is needed, because the provider forwards the bridge port itself (SSH `-L`
  or the native relay). [main.tf:resource.docker_container.workspace]
- The bootstrap must live at exactly `$HOME/.harness-bootstrap/claude-code`. The comment
  says a relocated pre-bake makes the session's `pnpm install` abort
  (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). [Dockerfile:HARNESS_CLAUDE_CODE_VERSION]
- The image build fails unless `./node_modules/.bin/claude --version` succeeds.
  [Dockerfile:HARNESS_CLAUDE_CODE_VERSION]
- The image removes the `ubuntu` user, adds `coder` to the `sudo` group with passwordless
  sudo, and runs as `coder` in `/home/coder`. [Dockerfile:USER]

## Side Effects

- `docker_image.workspace` pulls `var.image` onto the provisioner's Docker host when it is
  not already local. [main.tf:resource.docker_image.workspace]
- Each workspace gets a named volume `coder-<workspace id>-home`. Docker fills a new empty
  volume from the image's `/home/coder`, so the pre-baked bootstrap lands in it.
  [main.tf:resource.docker_volume.home_volume]
- The container runs the agent init script with `sh -c`, sets
  `CODER_AGENT_TOKEN`, and rewrites `localhost` or `127.0.0.1` in the init script to
  `host.docker.internal` (mapped to `host-gateway`).
  [main.tf:resource.docker_container.workspace]
- The image build downloads from the network: `apt-get`, the NodeSource script,
  `npm install -g pnpm@10`, `npm pack @ai-sdk/harness-claude-code@<version>`,
  `pnpm install --frozen-lockfile --store-dir .pnpm-store`, and the Claude Code
  `install.cjs`. [Dockerfile:HARNESS_CLAUDE_CODE_VERSION]

## Verification

- No automated check in this repo.
