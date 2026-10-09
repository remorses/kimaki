#!/bin/bash
# Kimaki Cloud init script.
# Runs inside the Fly machine at boot. The persistent volume is mounted at /root.
# kimaki and OpenCode come from the image so first boot can serve /kimaki/wake.
# KIMAKI_BOT_TOKEN (clientId:secret) is a Fly secret; kimaki saves it in SQLite
# and removes it from the env before it starts the OpenCode service.

set -euo pipefail

export HOME=/root

if [ ! -f /root/.kimaki-initialized ]; then
  echo "[kimaki-cloud] First boot, seeding volume..."
  mkdir -p /root/.config/opencode /root/.kimaki
  cat > /root/.config/opencode/opencode.json <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow"
}
EOF
  touch /root/.kimaki-initialized
fi

# The lock server is the Fly HTTP service: gateway-proxy POSTs /kimaki/wake to it.
export KIMAKI_LOCK_PORT=8080
export KIMAKI_SCALE_TO_ZERO=1

# Fly sets FLY_APP_NAME. gateway-proxy POSTs https://<app>.fly.dev/kimaki/wake.
export KIMAKI_INTERNET_REACHABLE_URL="https://${FLY_APP_NAME}.fly.dev"

echo "[kimaki-cloud] Starting kimaki..."
# Exit 0 after the idle window: Fly stops the VM (restart policy on-failure).
exec kimaki --gateway --data-dir /root/.kimaki --machine-name cloud
