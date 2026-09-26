---
title: Gateway architecture and onboarding
description: >
  How cli, gateway-proxy, website, and the shared Postgres database fit
  together, the gateway-proxy key files and auth flow, and the gateway-mode
  onboarding sequence. Read before editing gateway-proxy/, website onboarding
  routes, db/schema.prisma gateway tables, or bot credential / --gateway logic
  in cli/src/cli.ts. The multi-tenant REST safety rules live in AGENTS.md.
---

# Gateway architecture and onboarding

kimaki is a monorepo with three main packages that communicate via a shared Postgres database hosted on PlanetScale.

```
┌───────────────────────────────────────────────────────────────┐
│  User's machine                                               │
│  cli/ (TypeScript CLI + Discord bot)                          │
│  ├── src/cli.ts        main CLI, onboarding wizard            │
│  ├── src/discord-bot.ts  event loop, session routing          │
│  └── SQLite (~/.kimaki/discord-sessions.db)                   │
│         local state: bot tokens, channels, threads, models    │
└─────────┬────────────────────────────┬────────────────────────┘
          │ REST + WebSocket           │ polls /api/onboarding/status
          │ (clientId:secret)          │ during first-time setup
          ▼                            ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│  gateway-proxy/      │   │  website/                        │
│  (Rust, fly.io)      │   │  (Cloudflare Worker, Hono)       │
│                      │   │  https://kimaki.dev              │
│  Sits between the    │   │                                  │
│  CLI and Discord.    │   │  GET /oauth/callback             │
│  One shared bot for  │   │    → upserts gateway_clients row │
│  all users; users    │   │    → website/src/routes/         │
│  don't create their  │   │      oauth-callback.tsx          │
│  own Discord bot.    │   │                                  │
│                      │   │  GET /api/onboarding/status      │
│  Multi-tenant:       │   │    → CLI polls every 2s          │
│  filters events per  │   │    → website/src/routes/         │
│  client_id + guild   │   │      onboarding-status.ts        │
│                      │   │                                  │
│  wss://kimaki-       │   └──────────┬───────────────────────┘
│  gateway-production  │              │
│  .fly.dev            │              │
└──────────┬───────────┘              │
           │                          │
           ▼                          ▼
┌───────────────────────────────────────────────────────────────┐
│  Shared Postgres (PlanetScale)                                │
│  db/schema.prisma                                             │
│                                                               │
│  gateway_clients table:                                       │
│    client_id  TEXT   ── identifies the kimaki user            │
│    secret     TEXT   ── authenticates gateway connections     │
│    guild_id   TEXT   ── guild the user installed the bot in   │
│    @@id([client_id, guild_id])                                │
│                                                               │
│  Written by: website (on OAuth callback)                      │
│  Read by: gateway-proxy (polls every 1s via db_config.rs)     │
│  Read by: website (onboarding status check)                   │
└───────────────────────────────────────────────────────────────┘
```

## gateway-proxy (Rust)

`gateway-proxy/` is a Rust service that proxies both Discord Gateway (WebSocket) and REST traffic. It lets multiple users share a single Discord bot instead of each user creating their own.

Key files:

- `src/main.rs`: entry point, shard setup, HTTP server, DB polling
- `src/auth.rs`: authenticates `client_id:secret` tokens
- `src/db_config.rs`: polls Postgres `gateway_clients` every 1s, atomically swaps the in-memory client map. Stale protection: rejects auth if the DB is unreachable for more than 30s
- `src/server.rs`: HTTP+WS server. REST proxy at `/api/v10/*`, WebSocket upgrade for gateway
- `src/dispatch.rs`: per-shard event fanout, filters events by `authorized_guilds`
- `src/cache.rs`: builds synthetic READY payloads filtered to authorized guilds
- `src/rest_proxy.rs`: forwards REST calls, rewrites the Authorization header to the real bot token, scopes guild/channel routes

Auth flow:

```
IDENTIFY token "client_id:client_secret"
  → proxy validates against the CLIENTS map (from DB)
  → SessionPrincipal::Client(id) + authorized_guilds
  → only events for those guilds are forwarded
```

The REST scoping rules (guild-scoped routes, tokenized webhook/interaction routes, fail closed) are in the root `AGENTS.md` under "gateway REST safety".

## gateway onboarding flow (gateway mode)

Gateway-mode onboarding lives in `cli/src/cli.ts`, the `run()` function:

1. CLI generates `clientId` (UUID) + `clientSecret` (32-byte hex)
2. builds a Discord OAuth URL with `state=JSON({clientId, clientSecret})` and `redirect_uri=https://kimaki.dev/api/auth/callback/discord`
3. opens the browser to the Discord install URL
4. user authorizes the shared Kimaki bot in their server
5. Discord redirects to `website/src/routes/oauth-callback.tsx` with `guild_id` + `state`; the website upserts a `gateway_clients` row in Postgres
6. CLI polls `website/src/routes/onboarding-status.ts` every 2s until it finds the `client_id` + `secret` row, and gets back `guild_id`
7. CLI stores credentials locally via `setBotMode()` in SQLite with `bot_mode='gateway'` and `proxy_url` pointing to the gateway
8. bot connects with `clientId:clientSecret` as the Discord token; discord.js hits the gateway proxy, which routes events for authorized guilds only

Use `--gateway` to force gateway mode even if self-hosted credentials are already saved. It skips saved self-hosted creds and enters the gateway onboarding flow.
