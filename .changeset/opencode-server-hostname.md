---
'kimaki': minor
---

Add `--opencode-hostname` and `--opencode-port` so you can bind the OpenCode server Kimaki starts, including `0.0.0.0` on a VPS.

These flags do not bind Kimaki's own lock/hrana server. That stays on `127.0.0.1` unless `KIMAKI_INTERNET_REACHABLE_URL` is set.

By default OpenCode still listens on `127.0.0.1` and a random free port. On a VPS, pin both and set a password:

```bash
OPENCODE_SERVER_PASSWORD=replace-me \
  kimaki --opencode-hostname 0.0.0.0 --opencode-port 4096
```

Then attach from another machine:

```bash
opencode attach http://YOUR_VPS_IP:4096 --password replace-me
```

Kimaki refuses to start if `--opencode-hostname` is not loopback and `OPENCODE_SERVER_PASSWORD` is missing. `OPENCODE_SERVER_USERNAME` defaults to `opencode`. Kimaki itself still talks to the server at `127.0.0.1`; `0.0.0.0` only changes which interfaces accept connections.
