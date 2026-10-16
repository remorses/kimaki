---
title: Release process
description: >
  Steps to run after publishing the kimaki npm package: post the release to the #changelog Discord channel with the demo
  bot token, deploy the website, and redeploy the kimaki-demo Fly.io app.
  Read before any kimaki publish, release, changelog post, website deploy,
  or demo deploy.
---

# Release process

```
publish → gh release create → /tmp/kimaki-release.md → #changelog post → website deploy

kimaki-demo deploy (separate, when asked): bump Dockerfile version → pnpm fly deploy
```

## 1. post-publish release notification

After every publish, once the `gh release create` step is done:

1. write the gh release body to `/tmp/kimaki-release.md` so it can be reused without regenerating it
2. send a notification to the **#changelog** channel (`1514563453493313548`) in the Kimaki Discord Server with a markdown summary of the release

The #changelog channel is in a different guild than the local bot's authorized guild, so you must use the demo bot's gateway token via sigillo. The kimaki sigillo project (org: npm) has a `KIMAKI_BOT_TOKEN` secret in the `dev` environment with the demo bot's `clientId:clientSecret`.

Post it with Discord REST through the gateway proxy (the message must be at most 2000 chars):

```bash
jq -n --rawfile c /tmp/kimaki-release.md '{content: $c, allowed_mentions: {parse: []}}' > /tmp/kimaki-release.json
sigillo run -c dev -- sh -c 'curl -s -w "%{http_code}\n" -X POST -H "Authorization: Bot $KIMAKI_BOT_TOKEN" -H "Content-Type: application/json" --data @/tmp/kimaki-release.json https://discord-gateway.kimaki.dev/api/v10/channels/1514563453493313548/messages'
```

Run this from the kimakivoice repo root (where sigillo is set up). Do not use `kimaki send` here: in V2 it goes to the local bot when one runs, and without a local bot it posts a remote-send envelope that only a bot owning a **project** channel answers. #changelog is not a project channel.

The notification uses the version as a heading 1 title (e.g. `# v1.2.3`), followed by the same rich content as the gh release: descriptions, code examples, migration steps, before/after comparisons. Keep it detailed and user-facing, identical in quality to the gh release body.

## 2. deploy the website

After every kimaki publish, once the changelog is generated and the gh release exists, deploy the website to production:

```bash
cd website && pnpm deployment:production
```

The website shows the changelog and install instructions, so it must be updated right after each release.

## 3. official Discord demo (kimaki-demo)

`kimaki-demo/` is the Fly.io app for the public try-Kimaki bot in the official Kimaki Discord. People use it to try Kimaki without a local install.

Always bump `kimaki-demo/Dockerfile` (`kimaki@x.y.z`) to `npm view kimaki version` before deploy.

```bash
cd kimaki-demo
pnpm fly logs            # live logs
pnpm fly ssh console     # inspect /data/kimaki.log
pnpm fly deploy          # rebuild + deploy
```

If `fly` says no access token, the local 30-day flyctl session expired. Export `FLY_ACCESS_TOKEN` from `access_token` in `~/.fly/config.yml`, or run `fly auth login`.
