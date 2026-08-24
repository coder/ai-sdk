# Workspace image for @coder/ai-sdk-sandbox sessions with zero runtime install
# latency. See "Template authoring" in the package README for the full guide.
#
# The pre-bake step below mirrors the Claude Code adapter's bootstrap recipe
# (@ai-sdk/harness-claude-code ships the bridge's package.json, pnpm-lock.yaml,
# and bridge.mjs and runs the two commands below on first session use). Baking
# the same files, installed with the same commands, at the same absolute path
# means a session's bootstrap finds everything in place and downloads nothing.
FROM ubuntu:24.04

# Transport + bridge runtime requirements (see "Workspace requirements" in the
# README): bash + coreutils (base64, stty, printf) for the exec/file-IO/relay
# paths, Node.js >= 22 for the relay and bridge.mjs, pnpm for the bootstrap's
# `pnpm install`. NodeSource's nodejs ships npm; pnpm 10 reads the bridge's
# lockfileVersion 9.0 lockfile.
RUN apt-get update \
  && apt-get install -y ca-certificates curl git sudo \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y nodejs \
  && npm install -g pnpm@10 \
  && rm -rf /var/lib/apt/lists/*

# ubuntu:24.04 ships an "ubuntu" user at uid 1000; replace it with "coder" so
# the home volume convention matches Coder's example templates.
ARG USER=coder
RUN userdel -r ubuntu \
  && useradd --groups sudo --create-home --shell /bin/bash ${USER} \
  && echo "${USER} ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/${USER} \
  && chmod 0440 /etc/sudoers.d/${USER}
USER ${USER}
WORKDIR /home/${USER}

# Pre-bake the Claude Code bridge bootstrap at its FINAL path.
#
# - The path must be exactly $HOME/.harness-bootstrap/claude-code: the recipe
#   resolves it relative to the session's default working directory ($HOME for
#   this provider), and pnpm records the store as an absolute path in
#   node_modules/.modules.yaml — a relocated pre-bake makes the session's
#   `pnpm install` abort (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
# - Pin the adapter version to the one your host application resolves
#   (`pnpm why @ai-sdk/harness-claude-code`, or check its lockfile) via
#   `--build-arg HARNESS_CLAUDE_CODE_VERSION=...`. A different adapter on the
#   host re-runs the bootstrap against this directory and downloads the delta
#   (slower first session, still correct). The default matches the version
#   this repository's examples resolve.
ARG HARNESS_CLAUDE_CODE_VERSION=1.0.76
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
