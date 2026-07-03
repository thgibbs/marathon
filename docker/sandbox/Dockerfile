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
# Pin:    bump the base tag + package pins deliberately; the tag below is the
#         kernel's pinned toolchain, not a moving target.
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

# GitHub CLI from the official apt repo (public reads only — never a token).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (pinned), plus a writable HOME for the non-root sandbox
# user (uid 1000): package managers cache under $HOME.
RUN corepack enable && corepack prepare pnpm@10.6.1 --activate
ENV HOME=/tmp
WORKDIR /workspace
