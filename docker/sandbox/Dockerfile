# The pinned kernel toolchain image (code-migration.md Track 11; design §12.6).
#
# What a BUILD-stage agent needs to drive a normal repo checkout at /workspace:
# git for local version control (network git goes through the host broker),
# Node + pnpm/npm for JS/TS repos, gh for *public* GitHub reads (credentialed
# gh runs host-side via `github.exec` — no token ever enters this image), and
# common build tools. The container runs credential-free with outbound
# internet (Track 8): package installs and doc lookups are normal work here.
#
# Build:  make sandbox-image     (tags marathon-sandbox:kernel)
#
# Pinning (Track 11): the base image and gh are version-pinned below; bump
# SANDBOX_VERSION whenever anything here changes so drift is deliberate and
# observable (`cat /etc/marathon-sandbox/toolchain.txt` inside the image).
# Debian packages ride the pinned base snapshot; for byte-identical rebuilds,
# publish the built image and pin consumers to its digest — that, not a
# rebuild, is the production distribution path.
ARG SANDBOX_VERSION=5
FROM node:22.12.0-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        curl \
        git \
        jq \
        python3 \
        ripgrep \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI, version-pinned and checksum-verified against the release's own
# manifest (the moving apt "stable" repo would un-pin the toolchain).
# Public reads only — never a token.
ARG GH_VERSION=2.63.2
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.deb" \
    && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
    && sha256sum --check --ignore-missing "gh_${GH_VERSION}_checksums.txt" \
    && dpkg -i "gh_${GH_VERSION}_linux_${arch}.deb" \
    && rm -f "gh_${GH_VERSION}_linux_${arch}.deb" "gh_${GH_VERSION}_checksums.txt"

# pnpm, version-pinned via npm (registry-integrity-checked). Not corepack: the
# corepack bundled with this Node predates npm's 2025 signing-key rotation and
# fails signature verification.
RUN npm install -g pnpm@10.6.1 && npm cache clean --force

# Claude Code (headless) — the second Marathon harness (K7, claude-code-impl.md §8.1).
# EXACT-VERSION-PINNED, autoupdater disabled so the pin holds; re-verify the
# `claude-code-impl.md` §10 checklist against this version before relying on it.
# The CLI holds NO credentials in the image: the model call exits only through the
# host-side proxy (ANTHROPIC_BASE_URL), governed tools go through the broker socket.
ARG CLAUDE_CODE_VERSION=2.1.195
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Codex CLI (headless) — the third Marathon harness (K8, codex-cli-impl.md §8.1/§10).
# EXACT-VERSION-PINNED; re-verify the `codex-cli-impl.md` §10 verify-on-pin checklist
# (esp. #3 approval mode, #5 the npm install path, #7 the on-disk session layout)
# against this exact version before K8 closes. The CLI holds NO credentials in the
# image: the model call exits only through the host-injected CODEX_API_KEY at run
# time (§4.1), governed tools go through the broker socket. `codex` speaks OpenAI
# only, so the harness pins the provider (design §13.1).
ARG CODEX_VERSION=0.98.0
RUN npm install -g @openai/codex@${CODEX_VERSION} && npm cache clean --force

# The governed-tool MCP shim (stdio → per-task broker socket) and the
# Marathon-managed settings.json (deny rules, no hooks — defense-in-depth only, §3.3).
COPY marathon-mcp-shim.mjs /usr/local/bin/marathon-mcp-shim
COPY claude-settings.json /etc/marathon/claude-settings.json
RUN chmod +x /usr/local/bin/marathon-mcp-shim

# Toolchain manifest: what this build actually contains, so a rebuilt image
# that drifted is detectable at a glance.
ARG SANDBOX_VERSION
RUN mkdir -p /etc/marathon-sandbox && { \
        echo "sandbox_version: ${SANDBOX_VERSION}"; \
        echo "node: $(node --version)"; \
        echo "pnpm: $(pnpm --version)"; \
        echo "git: $(git --version)"; \
        echo "gh: $(gh --version | head -1)"; \
        echo "claude: $(claude --version 2>/dev/null || echo unknown)"; \
        echo "codex: $(codex --version 2>/dev/null || echo unknown)"; \
    } > /etc/marathon-sandbox/toolchain.txt
LABEL org.opencontainers.image.title="marathon-sandbox" \
      org.opencontainers.image.description="Marathon kernel BUILD sandbox toolchain" \
      io.marathon.sandbox.version="${SANDBOX_VERSION}"

# HOME lives INSIDE the workspace mount (Track 11): package-manager caches
# need task-sized disk, not the container's 64 MB /tmp tmpfs. The workspace
# manager excludes .marathon-home/ from the repo's git view, so caches never
# enter diffs, tree hashes, or commits — and nothing under HOME is a secret.
ENV HOME=/workspace/.marathon-home \
    npm_config_cache=/workspace/.marathon-home/.npm
WORKDIR /workspace
