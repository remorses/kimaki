# Changelog

## 0.1.0

- Added scoped actor API accessors for clearer test ergonomics (`channel(...)`, `thread(...)`, `user(...)`).
- Added richer deterministic text snapshots: typing markers, footer placeholders, and stable message ordering.
- Expanded gateway compatibility (Twilight `/gateway/` path support, multi-guild behavior, and configurable gateway URL).
- Improved interaction + wait flows for e2e reliability, including deterministic footer/typing tracking and better parallel test stability.
- Upgraded Prisma toolchain to `7.4.2`.
- Updated published package layout to ship built `dist` output, include `schema.prisma`, and run `generate + build` in `prepublishOnly`.

## 0.0.1

Initial release.

- Local Discord API twin (REST + Gateway WebSocket) for testing discord.js bots
- In-memory state with Prisma + libsql
- Full message lifecycle: create, edit, delete, reactions
- Thread management: create, archive, unarchive, thread members
- Interaction flows: slash commands, buttons, select menus, modals
- Guild management: channels, roles, members, active threads
- Playwright-style actor API: `discord.user(id).sendMessage(...)`, `.runSlashCommand(...)`, etc.
- Wait helpers: `waitForThread`, `waitForMessage`, `waitForBotReply`, `waitForInteractionAck`
