# Changelog

## 2026-03-01 00:47:47 CET (2026-02-28 23:47:47 UTC)

### Added

- Unified gateway authentication function for IDENTIFY and RESUME in
  `gateway-proxy/src/server.rs` (`authenticate_gateway_token`,
  `normalize_gateway_token`).
  - Behavior:
    - First attempts tenant auth via `client_id:secret`.
    - Falls back to bot token auth.
    - Supports `validate_token=false` mode explicitly via
      `SessionPrincipal::Unvalidated`.
  - Why: IDENTIFY and RESUME previously had different auth logic, which created
    correctness and security drift.

- Session principal model in `gateway-proxy/src/state.rs`:
  `SessionPrincipal::{BotToken, Client(String), Unvalidated(String)}`.
  - Behavior:
    - Session stores who authenticated it, not only shard/compression state.
    - Principal identity is now part of resume authorization.
  - Why: session ownership must be explicit so RESUME cannot cross auth domains.

- Session lifetime controls in `gateway-proxy/src/state.rs`:
  - Added `last_accessed: Instant` to `Session`.
  - Added `SESSION_TTL` (30 minutes).
  - Added pruning on `create_session` and `get_session`.
  - Why: reduces stale resumable sessions and bounds memory growth from old
    disconnected clients.

- Database staleness guard in `gateway-proxy/src/db_config.rs`:
  - Added `LAST_SUCCESSFUL_POLL_UNIX_SECS` and
    `CLIENT_DATA_STALE_AFTER_SECS` (30s).
  - Added `authenticate_client_with_id` that rejects tenant auth when DB-backed
    client registry is stale.
  - Why: if DB polling is down for too long, continuing tenant auth from stale
    in-memory data can violate revocation expectations.

### Changed

- RESUME path in `gateway-proxy/src/server.rs` now:
  - Re-authenticates token using the same path as IDENTIFY.
  - Fetches session by `session_id`.
  - Validates `session.principal == resume_auth.principal`.
  - Rejects mismatches with `INVALID_SESSION`.
  - Why: prevents cross-principal resume attempts (for example, attempting to
    resume a tenant session with a different auth identity).

- Tenant RESUME guild scope refresh in `gateway-proxy/src/server.rs`:
  - On successful tenant RESUME, forwarding uses freshly resolved guild set from
    current client registry instead of always trusting old session snapshot.
  - Why: narrows stale-authority windows after guild authorization changes.

- Event routing key extraction in `gateway-proxy/src/deserializer.rs`:
  - Added `find_data_field_u64` helper to parse numeric/string IDs.
  - `find_guild_id` now:
    - Uses `d.guild_id` for normal guild-scoped events.
    - Uses `d.id` for `GUILD_CREATE`, `GUILD_DELETE`, `GUILD_UPDATE`.
  - Why: lifecycle guild events do not carry `guild_id`; without this, those
    live events were skipped for filtered tenants.

### Security / Correctness Impact

- **Session hijack resistance improved:** RESUME now requires principal match,
  not only possession of session ID.
- **Authorization freshness improved:** tenant resume path can pick up updated
  guild grants from live registry.
- **Event routing correctness improved:** live guild lifecycle events now pass
  filtering correctly.
- **Operational safety improved during DB incidents:** stale registry age now
  gates tenant authentication when DB polling is unhealthy.

### Compatibility Notes

- Legacy bot-token clients continue to work.
- `validate_token=false` remains supported, now explicitly represented as an
  unvalidated principal in session state.
- Startup behavior remains compatible when `DATABASE_URL` is set but polling has
  not yet completed a first successful cycle.

### Validation

- `cargo fmt` in `gateway-proxy/`
- `cargo check` in `gateway-proxy/` (pass)
- `pnpm tsc` in `discord/` (pass)
