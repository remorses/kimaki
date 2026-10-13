---
name: kimaki-tunnel
description: Share a local dev server with the user through a public URL. Use when the user should open a localhost app in a browser, test a webhook or OAuth callback against a local server, or preview a dev server from Discord. Runs `kimaki tunnel` in a named background tuistory session. ALWAYS load before starting a dev server the user must open. Only for Kimaki Discord sessions.
---

# Dev servers with tunnel access

Localhost URLs are useless from Discord. Wrap the dev server in `kimaki tunnel` to get a public URL, and run it in a named background `tuistory` session so you can wait for output, read logs and stop it later. Name the session descriptively (e.g. `projectname-dev`) and reuse it. Run `tuistory --help` first (or `bunx tuistory` when it is not installed). Invoke `kimaki` directly, not via `npx` or `bunx`.

- Use random tunnel IDs by default. Pass `-t <id>` only for services that are safe to be publicly discoverable.
- `kimaki tunnel` detects the local port from the child output. Pass `--port` only when the server prints no detectable localhost URL or port line.
- `kimaki tunnel` injects `TRAFORO_URL` into the child process. Wire the app to it so OAuth callbacks, webhook URLs and absolute links use the public URL.

```bash
# start in a named background session, wait for output, then read the tunnel URL
tuistory launch "kimaki tunnel -- pnpm dev" -s myapp-dev
tuistory -s myapp-dev wait "/ready|local|tunnel/i" --timeout 30000
tuistory read -s myapp-dev

# pass the public URL to the app (better-auth, Next.js, Vite; node reads process.env.TRAFORO_URL)
tuistory launch "kimaki tunnel -- sh -c 'BETTER_AUTH_URL=$TRAFORO_URL exec pnpm dev'" -s myapp-dev
tuistory launch "kimaki tunnel -- sh -c 'APP_URL=$TRAFORO_URL exec pnpm dev'" -s myapp-dev
tuistory launch "kimaki tunnel -- sh -c 'VITE_BASE_URL=$TRAFORO_URL exec pnpm dev'" -s myapp-dev

# custom tunnel ID (only for intentionally public-safe services)
tuistory launch "kimaki tunnel -t holocron -- pnpm dev" -s holocron-dev

# list sessions; stop with Ctrl+C, then close
tuistory sessions
tuistory -s myapp-dev press ctrl c
tuistory -s myapp-dev close
```

Share the printed public URL with the user as a clickable link. Stop the session when the user is done.
