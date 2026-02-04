
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

we use prisma to write type safe queries. after adding new tables you should also run the command `pnpm generate` inside discord to generate again the prisma code.

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
