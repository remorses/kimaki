# Kimaki Discord DB Guide

## Database setup

- SQLite database lives in the user data directory as `discord-sessions.db`.
- Schema changes are managed only via Prisma migrations stored in `discord/migrations`.
- `discord/prisma/empty.db` is the committed baseline DB used to generate new migrations.

## Adding new fields / tables

1. Update `discord/schema.prisma`.
2. Generate a migration against the baseline DB:

```bash
pnpm prisma migrate dev --create-only --name <your-change> --url "file:prisma/empty.db"
```

3. Apply migrations to the baseline DB so it stays current for the next change:

```bash
pnpm prisma migrate dev --url "file:prisma/empty.db"
```

4. Commit the new migration folder under `discord/migrations` and the updated `prisma/empty.db`.

## How migrations run at startup

- The CLI calls `applyPrismaMigrations` in `discord/src/db.ts` on startup.
- It reads SQL files under `discord/migrations/<timestamp>_<name>/migration.sql`.
- Each migration is applied once and recorded in the `kimaki_migrations` table.
- The baseline migration is skipped when tables already exist, so existing user DBs
  only receive new ALTER migrations.
