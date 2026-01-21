# restarting the discord bot

ONLY restart the discord bot if the user explicitly asks for it.

To restart the discord bot process so it uses the new code, send a SIGUSR2 signal to it.

1. Find the process ID (PID) of the kimaki discord bot (e.g., using `ps aux | grep kimaki` or searching for "kimaki" in process list).
2. Send the signal: `kill -SIGUSR2 <PID>`

The bot will wait 1000ms and then restart itself with the same arguments.

## sqlite

this project uses sqlite to preserve state between runs. the database should never have breaking changes, new kimaki versions should keep working with old sqlite databases created by an older kimaki version. if this happens specifically ask the user how to proceed, asking if it is ok adding migration in startup so users with existing db can still use kimaki and will not break.

## errore

errore is a submodule. should always be in main. make sure it is never in detached state.

it is a package for using errors as values in ts.
