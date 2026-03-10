# Memory

- Platform adapter migration: shared platform types should not expose `raw` or
  `discord.js` shapes. If shared code needs a new behavior, add it to the
  adapter contract explicitly.
- Prefer a resource-oriented adapter API over a flat bag of functions:
  `adapter.channel(id)`, `adapter.thread(id)`, `adapter.conversation(target)`,
  and message/thread handles with fluent operations.
- Group platform-specific capabilities under structured namespaces such as
  permissions, command metadata, uploads, mentions, and voice instead of adding
  ad hoc methods to event objects.

## Security Audit Findings (March 2026)

**Gateway-Proxy & Discord Bot Authentication Model:**

- Multi-tenant architecture with single shared Discord bot is well-designed. Each
  user gets `client_id:secret` token scoped to 1 guild (install guild).
- Gateway filters events by `authorized_guilds` set: guild-scoped events checked
  against whitelist, events with no guild_id dropped for multi-tenant clients.
- READY payload rebuilt to only include authorized guilds (cache.rs:76-141).
- REST routes deterministically scoped (guild, channel, allowed-without-guild,
  allowed-without-auth, denied). Per-client authorization enforced.
- Critical: `/webhooks/{id}` properly denied (requires bot token).
- Tokenized routes (`/interactions/{id}/{token}`, `/webhooks/{id}/{token}`)
  bypass auth correctly (short-lived Discord tokens).
- DB sync is resilient: stale protection >30s without sync rejects auth, LISTEN/NOTIFY
  with polling fallback, initial startup blocks max 10s.

**No Critical Vulnerabilities Found:**

- No auth bypasses or cross-tenant message leakage
- No privilege escalation paths
- Permission checks in place for messages/interactions
- Session routing is thread-scoped

**Minor Edge Cases:**

- Channel guild resolution has ~100ms TOCTOU window (unlikely impact, cache-first
  mitigates).
- Secret comparison uses `==` not constant-time (acceptable: 256-bit entropy,
  disconnect-on-fail prevents brute-force).

**New Adapter Layer:**

- Maintains security invariants: no raw discord.js objects leak to runtime, platform
  details encapsulated, event normalization prevents bypasses.
- Defensive instanceof checks for interaction access (not `as` casts).
- Slack adapter must implement same `permissions.getMessageAccess()` and guild
  scoping as Discord.

**Recommendations:**

- Use subtle crate for constant-time secret comparison (defense-in-depth).
- Add audit logging for failed auth, stale rejections, channel resolution failures.
- Document Slack adapter security requirements.
- Consider rate limiting per client_id.

See SECURITY_AUDIT.md for full analysis (~9500 lines reviewed).
