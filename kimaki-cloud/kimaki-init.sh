#!/bin/bash
# Kimaki Cloud init script.
# Runs inside the Fly machine at boot. The persistent volume is mounted at /root,
# so everything the script installs or configures survives image updates.
#
# First boot: installs kimaki, opencode, and agent tools into the volume.
# Every boot: background-updates kimaki + opencode to latest, then starts kimaki.

set -euo pipefail

export HOME=/root
export PATH="/root/.bun/bin:/root/.npm-global/bin:$PATH"

# npm global prefix on the volume so globally installed bins persist
npm config set prefix /root/.npm-global 2>/dev/null || true

# First boot: seed the volume with tools and config
if [ ! -f /root/.kimaki-initialized ]; then
  echo "[kimaki-cloud] First boot — installing tools into volume..."

  mkdir -p /root/.config/opencode /root/.kimaki /root/projects /root/bin /root/.npm-global

  # opencode permissions: allow all without prompting (no human to approve)
  cat > /root/.config/opencode/opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow"
}
EOF

  echo "[kimaki-cloud] Installing kimaki and opencode..."
  npm install -g kimaki@latest opencode@latest

  echo "[kimaki-cloud] Installing agent tools..."
  bun install -g critique tuistory opensrc 2>/dev/null || true

  touch /root/.kimaki-initialized
  echo "[kimaki-cloud] First boot setup complete."
fi

# Every boot: update kimaki + opencode in background so the bot starts immediately
# with whatever version is currently installed. The update runs async;
# if a new version lands, it's available on next restart.
echo "[kimaki-cloud] Starting background update check..."
(npm update -g kimaki opencode 2>/dev/null && echo "[kimaki-cloud] Update check done.") &

echo "[kimaki-cloud] Starting kimaki..."
exec kimaki --gateway \
  --data-dir /root/.kimaki \
  --projects-dir /root/projects \
  --allow-all-users \
  --auto-restart
