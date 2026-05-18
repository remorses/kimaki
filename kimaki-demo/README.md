# kimaki-demo

Fly.io deployment for a public "try Kimaki" Discord server. Runs kimaki in **gateway mode** so no bot token or API keys are needed. Anyone who joins the Discord server can message the bot and get AI responses using free models.

## How it works

The Fly machine runs `kimaki --gateway`, which connects to the shared Kimaki bot via the gateway proxy. On first boot, kimaki generates credentials and emits an install URL in the logs. An admin visits that URL to authorize the bot in the demo Discord server. After that, credentials are saved on the persistent volume and subsequent deploys just work.

```
┌──────────────────────────────────────────────────────────────┐
│  Fly.io org: kimaki-demo (isolated 6PN, no access to other  │
│  orgs or internal services)                                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Machine: shared-cpu-1x, 1GB RAM                       │  │
│  │  node:24 + bun + git + kimaki                          │  │
│  │                                                        │  │
│  │  /data/ (persistent volume)                            │  │
│  │    ├── discord-sessions.db  (bot state + creds)        │  │
│  │    ├── projects/            (user-created projects)    │  │
│  │    └── bin/                 (opencode binary cache)    │  │
│  └──────────┬─────────────────────────────────────────────┘  │
│             │ public internet only                            │
└─────────────┼────────────────────────────────────────────────┘
              ▼
┌──────────────────────────┐       ┌──────────────────────┐
│  gateway-proxy            │  ◄──► │  Discord              │
│  wss://discord-gateway    │       │  demo server          │
│  .kimaki.dev              │       │  free models, no keys │
└──────────────────────────┘       └──────────────────────┘
```

## Security

The demo machine runs in a **separate Fly.io organization** (`kimaki-demo`). This gives it a completely isolated 6PN private network with zero visibility into gateway-proxy, the website, or any other infrastructure. The machine connects to the gateway proxy over the public internet, same as any other kimaki user.

Users interact with the AI through Discord. The AI can run shell commands inside the Fly VM, but the root filesystem is ephemeral (wiped on redeploy) and only `/data` persists on the volume. The 1GB RAM shared CPU makes compute abuse impractical.

## Prerequisites

- [flyctl](https://fly.io/docs/flyctl/install/) installed and authenticated
- A Discord server for the demo (create one if you don't have it)

## Deploy

```bash
# create isolated org
fly orgs create kimaki-demo

# create the app inside the isolated org
fly apps create kimaki-demo --org kimaki-demo

# create persistent volume (5GB, adjust region as needed)
fly volumes create kimaki_data --size 5 --region iad --app kimaki-demo

# deploy
cd kimaki-demo
fly deploy
```

## First-time authorization

On the first deploy, kimaki needs to be authorized in the Discord server. Check the logs for the install URL:

```bash
fly logs --app kimaki-demo
```

Look for a line like:

```
data: {"type":"install_url","url":"https://kimaki.dev/discord-install?clientId=...&clientSecret=..."}
```

Visit that URL in your browser, select the demo Discord server, and click "Authorize". The bot will connect automatically. Credentials are saved to the persistent volume, so you only need to do this once.

## Updating

Redeploy to pull the latest `kimaki@latest` from npm:

```bash
cd kimaki-demo
fly deploy
```

The persistent volume keeps all credentials and project data across deploys.

## Logs

```bash
fly logs --app kimaki-demo
```

## SSH into the machine

```bash
fly ssh console --app kimaki-demo
```
