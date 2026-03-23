---
title: Screen Sharing
description: Share your machine's screen to anyone with a browser link via Kimaki.
---

# Screen Sharing

Share your machine's screen to anyone with a browser link. Uses VNC under the hood, bridged through a WebSocket proxy and exposed via a kimaki tunnel.

```bash
# Start sharing (runs in foreground, Ctrl+C to stop)
kimaki screenshare

# Run in background with tmux
tmux new-session -d -s screenshare "kimaki screenshare"
```

Or use the `/screenshare` slash command in Discord — it posts the URL directly in the channel.

Sessions auto-stop after **1 hour**. Use `/screenshare-stop` or Ctrl+C to stop earlier.

## macOS Setup

macOS requires **Remote Management** enabled (not just Screen Sharing) for full mouse and keyboard control:

1. Go to **System Settings > General > Sharing > Remote Management**
2. Enable **"VNC viewers may control screen with password"**
3. Set a VNC password

Or via terminal:

```bash
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -allowAccessFor -allUsers -privs -all \
  -clientopts -setvnclegacy -vnclegacy yes \
  -restart -agent -console
```

## Linux Setup

Requires `x11vnc` and a running X11 display (`$DISPLAY`):

```bash
sudo apt install x11vnc
```

Kimaki spawns `x11vnc` automatically when you start screen sharing.
