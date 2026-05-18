# Kimaki demo server — runs the Discord bot in gateway mode on Fly.io.
# Uses the shared Kimaki bot via gateway-proxy, no bot token needed.
# Credentials are generated on first boot and persisted on the volume.

FROM node:24-slim

# git, curl, unzip are required (git for opencode, curl+unzip for bun installer)
RUN apt-get update && apt-get install -y git curl unzip && rm -rf /var/lib/apt/lists/*

# Install bun (required by opencode)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install kimaki globally from npm
RUN npm install -g kimaki@latest

# Pre-install tools the AI agent uses via bunx so first invocations are instant.
# critique: diff viewing and sharing (bunx critique --web)
# tuistory: background process management for dev servers (bunx tuistory)
# opensrc: read dependency source code for context (bunx opensrc)
RUN bun install -g critique tuistory opensrc

# Create persistent data directories on the volume mount point
RUN mkdir -p /data/projects

WORKDIR /data

# --gateway: use the shared Kimaki bot via gateway-proxy (no bot token needed)
# --data-dir /data: store sqlite DB and config on the persistent volume
# --projects-dir /data/projects: store user-created projects on the volume
# --allow-all-users: anyone in the Discord server can use the bot (add back after next kimaki publish)
# --auto-restart: respawn wrapper for crash recovery inside the container
CMD ["kimaki", "--gateway", "--data-dir", "/data", "--projects-dir", "/data/projects", "--auto-restart"]
