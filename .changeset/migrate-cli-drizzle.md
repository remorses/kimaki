---
'kimaki': patch
---

Migrate Kimaki's local SQLite database layer from Prisma to Drizzle/libSQL.

The CLI keeps the same on-disk database and startup migration behavior, but now uses Drizzle schema inference for local database types and Drizzle Kit for generating `schema.sql`. This removes Prisma from the published CLI package while preserving the Hrana/libSQL HTTP path used by the OpenCode plugin process.
