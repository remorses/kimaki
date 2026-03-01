<!-- Agent guidance for website package contributors and automation. -->

# website purpose

The `website` package is the HTTP layer for Kimaki onboarding.

It is responsible for:

- `GET /oauth/callback`: finalize OAuth install flow and persist
  `client_id + secret + guild_id` mapping.
- `GET /api/onboarding/status`: polled by CLI to detect onboarding completion.

# split with gateway-proxy

`gateway-proxy` handles Discord Gateway **WebSocket** traffic and Discord REST
proxying (`/api/v10/*`).

`website` handles **onboarding only**.

Keep this split explicit unless there is a deliberate architecture migration.
