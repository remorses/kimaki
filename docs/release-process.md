---
title: Release process
description: >
  Steps to run before and after publishing the kimaki npm package: sync
  skills, post the release to the #changelog Discord channel with the demo
  bot token, deploy the website, and redeploy the kimaki-demo Fly.io app.
  Read before any kimaki publish, release, changelog post, website deploy,
  or demo deploy.
---

# Release process

```
pnpm sync-skills → commit skill changes → publish → gh release create
  → /tmp/kimaki-release.md → #changelog post → website deploy

kimaki-demo deploy (separate, when asked): bump Dockerfile version → pnpm fly deploy
```

## 1. pre-publish: sync skills

Before publishing to npm, always sync skills as the first step:

```bash
cd cli && pnpm sync-skills
```

This makes the npm package ship the latest synced skills from their source repos. Commit any skill changes before you continue with the publish.

## 2. post-publish release notification

After every publish, once the `gh release create` step is done:

1. write the gh release body to `/tmp/kimaki-release.md` so it can be reused without regenerating it
2. send a notification to the **#changelog** channel (`1514563453493313548`) in the Kimaki Discord Server with a markdown summary of the release

The #changelog channel is in a different guild than the local bot's authorized guild, so you must use the demo bot's gateway token via sigillo. The kimaki sigillo project (org: npm) has a `KIMAKI_BOT_TOKEN` secret in the `dev` environment with the demo bot's `clientId:clientSecret`.

```bash
sigillo run -c dev -- kimaki send --channel 1514563453493313548 --prompt "$(cat /tmp/kimaki-release.md)" --notify-only --user '535922349652836367'
```

Run this from the kimakivoice repo root (where sigillo is set up). `KIMAKI_BOT_TOKEN` takes priority over local DB credentials when set, so `kimaki send` authenticates as the demo bot through the gateway proxy.

The notification uses the version as a heading 1 title (e.g. `# v1.2.3`), followed by the same rich content as the gh release: descriptions, code examples, migration steps, before/after comparisons. Keep it detailed and user-facing, identical in quality to the gh release body.

When `--notify-only` targets a non-project channel, the message is posted directly without a thread. For project channels, a thread is still created so users can reply to start a session.

## 3. deploy the website

After every kimaki publish, once the changelog is generated and the gh release exists, deploy the website to production:

```bash
cd website && pnpm deployment:production
```

The website shows the changelog and install instructions, so it must be updated right after each release.

## 4. official Discord demo (kimaki-demo)

`kimaki-demo/` is the Fly.io app for the public try-Kimaki bot in the official Kimaki Discord. People use it to try Kimaki without a local install.

Always bump `kimaki-demo/Dockerfile` (`kimaki@x.y.z`) to `npm view kimaki version` before deploy.

```bash
cd kimaki-demo
pnpm fly logs            # live logs
pnpm fly ssh console     # inspect /data/kimaki.log
pnpm fly deploy          # rebuild + deploy
```

If `fly` says no access token, the local 30-day flyctl session expired. Export `FLY_ACCESS_TOKEN` from `access_token` in `~/.fly/config.yml`, or run `fly auth login`.
