# restarting the discord bot

ONLY restart the discord bot if the user explicitly asks for it.

To restart the discord bot process so it uses the new code, send a SIGUSR2 signal to it.

1. Find the process ID (PID) of the kimaki discord bot (e.g., using `ps aux | grep kimaki` or searching for "kimaki" in process list).
2. Send the signal: `kill -SIGUSR2 <PID>`

The bot will wait 1000ms and then restart itself with the same arguments.

# showing diffs with critique

To show the user a visual diff of changes made, use the critique command:

```bash
bunx critique web
```

This uploads the diff to a temporary URL that the user can view. The URL expires in 7 days.

To show changes from a specific commit instead of working directory:

```bash
bunx critique web HEAD~1
```
