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
ARG SANDBOX_VERSION=1
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

# Toolchain manifest: what this build actually contains, so a rebuilt image
# that drifted is detectable at a glance.
ARG SANDBOX_VERSION
RUN mkdir -p /etc/marathon-sandbox && { \
        echo "sandbox_version: ${SANDBOX_VERSION}"; \
        echo "node: $(node --version)"; \
        echo "pnpm: $(pnpm --version)"; \
        echo "git: $(git --version)"; \
        echo "gh: $(gh --version | head -1)"; \
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
