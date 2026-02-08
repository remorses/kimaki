after every change always run tsc inside discord to validate your changes. try to never use as any

do not use spawnSync. use our util execAsync. which uses spawn under the hood

# restarting the discord bot

ONLY restart the discord bot if the user explicitly asks for it.

To restart the discord bot process so it uses the new code, send a SIGUSR2 signal to it.

1. Find the process ID (PID) of the kimaki discord bot (e.g., using `ps aux | grep kimaki` or searching for "kimaki" in process list).
2. Send the signal: `kill -SIGUSR2 <PID>`

The bot will wait 1000ms and then restart itself with the same arguments.

## sqlite

this project uses sqlite to preserve state between runs. the database should never have breaking changes, new kimaki versions should keep working with old sqlite databases created by an older kimaki version. if this happens specifically ask the user how to proceed, asking if it is ok adding migration in startup so users with existing db can still use kimaki and will not break.


you should prefer never deleting or adding new fields. we rely in a schema.sql generated inside src to initialize an update the database schema for users.

if we added new fields on the schema then we would also need to update db.ts with manual sql migration code to keep existing users databases working.

## prisma

we use prisma to write type safe queries. the database schema is defined in `discord/schema.prisma`.

`discord/src/schema.sql` is **generated** from the prisma schema - never edit it directly. to regenerate it after modifying schema.prisma:

```bash
cd discord && pnpm generate
```

this runs `prisma generate` (for the client) and `pnpm generate:sql` (which creates a temp sqlite db and extracts the schema).

when adding new tables:
1. add the model to `discord/schema.prisma`
2. run `pnpm generate` inside discord folder
3. add getter/setter functions in `database.ts` if needed

database.ts has some functions that abstract complex prisma queries or inserts. ONLY add them there if they are very complex or used a lot. prefer inlining the prisma queries if possible

## errore

errore is a submodule. should always be in main. make sure it is never in detached state.

it is a package for using errors as values in ts.

## opencode

if I ask you questions about opencode you can opensrc it from anomalyco/opencode

## discord bot messages
 
try to not use emojis in messages

when creating system messages like replies to commands never add new line spaces between paragraphs or lines. put one line next to the one before.

## AGENTS.md

AGENTS.md is generated. only edit KIMAKI_AGENTS.md instead. pnpm agents.md will generate the file again.

## resolving project directories in commands

use `resolveWorkingDirectory({ channel })` from `discord-utils.ts` to get directory paths in slash commands. it returns:
- `projectDirectory`: base project dir, used for `initializeOpencodeForDirectory` (server is keyed by this)
- `workingDirectory`: worktree dir if thread has an active worktree, otherwise same as `projectDirectory`. use this for `cwd` in shell commands and for SDK `directory` params
- `channelAppId`: optional app ID from channel metadata

never call `getKimakiMetadata` + manual `getThreadWorktree` check in commands. the util handles both. if you need to encode a directory in a discord customId for later use with `initializeOpencodeForDirectory`, always use `projectDirectory` not `workingDirectory`.

## heap snapshots and memory debugging

kimaki has a built-in heap monitor that runs every 30s and checks V8 heap usage.

- **85% heap used**: writes a `.heapsnapshot` file to `~/.kimaki/heap-snapshots/`

to manually trigger a heap snapshot at any time:

```bash
kill -SIGUSR1 <PID>
```

snapshots are saved as `heap-<date>-<sizeMB>MB.heapsnapshot` in `~/.kimaki/heap-snapshots/`.
open them in Chrome DevTools (Memory tab > Load) to inspect what is holding memory.
there is a 5 minute cooldown between automatic snapshots to avoid disk spam.

signal summary:
- `SIGUSR1`: write heap snapshot to disk
- `SIGUSR2`: graceful restart (existing)

the implementation is in `discord/src/heap-monitor.ts`.

## logging

always try to use logger instead of console. so logs in the cli look uniform and pretty

for the log prefixes always use short names
