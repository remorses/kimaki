<!-- Purpose: package overview and Slack OAuth scopes required for Kimaki parity. -->

# discord-slack-bridge

`discord-slack-bridge` lets a `discord.js` bot control a Slack workspace by
translating Discord Gateway + REST behavior to Slack APIs.

## Slack app scopes for Kimaki

To let Kimaki do the same core actions it does on Discord (commands, channel
and thread lifecycle, messages, reactions, file uploads), configure these bot
token scopes in your Slack app OAuth settings:

- `commands`
- `chat:write`
- `chat:write.public`
- `channels:manage`
- `groups:write`
- `channels:read`
- `groups:read`
- `channels:history`
- `groups:history`
- `reactions:write`
- `users:read`
- `files:write`

Depending on your workspace setup and which surfaces you enable, you may also
need additional scopes (for example `files:read`, `im:history`, `mpim:history`,
or `users:read.email`).

After changing scopes, reinstall the Slack app to refresh the bot token.
