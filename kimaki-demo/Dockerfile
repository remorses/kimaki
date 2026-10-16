# Kimaki demo server — runs the Discord bot in gateway mode on Fly.io.
# Uses the shared Kimaki bot via gateway-proxy, no bot token needed.
# Credentials are generated on first boot and persisted on the volume.

FROM node:24-slim

# git for opencode, curl for the installers, unzip for the bun installer,
# python3/make/g++ for node-gyp (tree-sitter has no linux prebuild for the bunx tools)
RUN apt-get update && apt-get install -y git curl unzip python3 make g++ && rm -rf /var/lib/apt/lists/*

# Bun runs the bunx tools the agent uses (critique, tuistory, opensrc)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install kimaki globally from npm.
# IMPORTANT: always use the latest published version here.
# Check with: npm view kimaki version
# Bump this after publishing a new kimaki version, then fly deploy.
RUN npm install -g kimaki@1.2.0

# OpenCode V2. Kimaki does not bundle it and starts the OpenCode service itself.
# Pin the version so the build does not depend on the latest-version API.
# Check with: curl -fsSL https://opencode.ai/update/api/latest/cli/npm
RUN curl -fsSL https://opencode.ai/v2/install | bash -s -- --version 2.0.31 --no-modify-path
ENV PATH="/root/.opencode/bin:$PATH"

# Pre-install tools the AI agent uses via bunx so first invocations are instant.
# critique: diff viewing and sharing (bunx critique --web)
# tuistory: background process management for dev servers (bunx tuistory)
# opensrc: read dependency source code for context (bunx opensrc)
RUN bun install -g critique tuistory opensrc

# Create persistent data directories on the volume mount point
RUN mkdir -p /data/projects

ENV OPENCODE_ENABLE_EXA=1

WORKDIR /data

# OpenCode V2 config. The demo has no human to approve permission prompts,
# so every action is allowed.
RUN mkdir -p /root/.config/opencode && \
    printf '{\n  "model": "opencode/big-pickle",\n  "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }]\n}\n' > /root/.config/opencode/opencode.json

# --gateway: use the shared Kimaki bot via gateway-proxy (no bot token needed)
# --data-dir /data: store sqlite DB and config on the persistent volume
# --allow-all-users: anyone in the Discord server can use the bot
# The root kimaki process supervises the bot and respawns it on restart.
CMD ["kimaki", "--gateway", "--data-dir", "/data", "--allow-all-users"]
