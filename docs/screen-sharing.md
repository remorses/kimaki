---
title: Screen Sharing
description: Share your machine's screen to anyone with a browser link via Kimaki.
---

# Screen Sharing

Share your machine's screen to anyone with a browser link. Uses VNC under the hood, bridged through a WebSocket proxy and exposed via a kimaki tunnel.

```bash
# Start sharing (runs in foreground, Ctrl+C to stop)
kimaki screenshare

# Run in background with tuistory
tuistory launch "kimaki screenshare" -s screenshare
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

Kimaki auto-detects your display server (X11 or Wayland) and uses the appropriate VNC backend.

### X11

Requires `x11vnc`:

```bash
sudo apt install x11vnc
```

### Wayland (GNOME)

Requires TigerVNC 1.16+ (`w0vncserver`):

```bash
sudo apt install tigervnc-standalone-server
```

**Note:** First use may show a permission dialog asking to allow screen capture. Click "Allow" once — the permission is remembered.

### Wayland (Sway, River, Wayfire)

Requires `wayvnc`:

```bash
sudo apt install wayvnc
```

Kimaki spawns the correct VNC server automatically when you start screen sharing.
