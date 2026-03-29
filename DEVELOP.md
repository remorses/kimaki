# Development Guide

This guide covers the correct workflow for developing and testing kimaki locally.

## Project Structure

Kimaki is a monorepo with the main Discord bot code in the `discord/` package. This is a **local variant** of kimaki (local voice transcription) that should be linked globally instead of using the npm-published version.

```
/opt/homebrew/bin/kimaki -> ../lib/node_modules/kimaki/bin.js -> /Users/caffae/Local-Projects-2026/kimaki/discord
```

## Quick Start: Link Local Variant

After making changes, rebuild and link the local variant globally:

```bash
cd discord && pnpm link
```

This compiles TypeScript and links the local `kimaki` binary globally, replacing any npm-installed version.

**Important**: If you installed kimaki via npm globally (`npm install -g kimaki`), run `npm uninstall -g kimaki` first to avoid conflicts.

## Development Workflow

### 1. Make Changes to TypeScript Files

Edit files in `discord/src/`. The main package to work on is the `discord` package.

### 2. Rebuild and Link

After making changes to TypeScript files:

```bash
cd discord
pnpm link
```

This runs `tsc` to compile and `npm link` to make the local variant globally available.

Alternatively, if you just want to compile without linking:

```bash
cd discord
pnpm build
```

This compiles TypeScript source to JavaScript in the `dist/` directory, which is what the running bot actually executes.

**Important**: The TypeScript compiler is configured via `discord/tsconfig.json` with `outDir: "dist"` and `rootDir: "src"`. Always run `tsc` from the `discord/` directory, not the root.

### 3. Restart the Bot

After compilation, restart the kimaki bot to load the new code:

```bash
# Find the kimaki bot process
ps aux | grep "kimaki" | grep -v grep

# Send SIGUSR2 signal to gracefully restart the bot
kill -SIGUSR2 <PID>
```

The bot will:
1. Wait 1000ms
2. Restart itself with the same arguments
3. Load the newly compiled code from `dist/`

### 4. Verify Changes

Check the bot startup logs to confirm new behavior:

```bash
tail -f ~/.kimaki/kimaki.log
```

Or view recent logs:

```bash
tail -20 ~/.kimaki/kimaki.log
```

## Common Issues

### Changes Not Appearing

If your changes don't seem to be active:
1. Check you ran `npx -y tsc` in the `discord/` directory (not root)
2. Verify the compiled timestamp on the JavaScript file: `ls -la dist/your-file.js`
3. Confirm the bot restarted: check logs for `[LOG] [CLI] Starting Discord bot...` message

### TypeScript Compilation Errors

After editing TypeScript, always check for compilation errors:

```bash
cd discord
npx -y tsc
```

If you see errors, fix them before restarting the bot. The kimaki AGENTS.md specifies to always run `tsc` inside discord after important changes.

### Bot Not Restarting

If `kill -SIGUSR2` doesn't restart the bot:
1. Check the process ID is correct: `ps aux | grep kimaki`
2. Verify the process exists: `ps -p <PID>`
3. Check logs for restart messages: `tail ~/.kimaki/kimaki.log`

If the bot is completely stuck, you may need to kill and restart manually, but this should be rare.

## Quick Reference

| Action | Command |
|--------|---------|
| Compile TypeScript | `cd discord && npx -y tsc` |
| Find bot PID | `ps aux | grep kimaki | grep -v grep` |
| Restart bot | `kill -SIGUSR2 <PID>` |
| View logs | `tail -f ~/.kimaki/kimaki.log` |
| Check compiled file | `ls -la dist/your-file.js` |

## Important Notes

- **Never use `&` to run commands in background** - it's leaky and harmful. Use `tmux` if you need background processes.
- **Always run `npx -y tsc` from the `discord/` directory** - the root package doesn't have a direct tsconfig
- **SIGUSR2 is the correct way to restart** - don't force kill unless absolutely necessary
- **The bot log file resets on every startup** - `~/.kimaki/kimaki.log` only contains logs from the current run

## Testing After Changes

After making code changes, especially for critical functionality like:
- Queueing or message handling → run full test suite: `cd discord && pnpm test`
- Voice transcription → test with a voice message attachment
- Discord slash commands → test in Discord channel

Always verify your changes work as expected before committing.

## Related Documentation

- `AGENTS.md` - Project guidelines and architecture
- `KIMAKI_AGENTS.md` - Agent-specific instructions (generated, edit KIMAKI_AGENTS.md instead)
- `PARAKEET_SETUP_COMPLETE.md` - Parakeet ASR service setup guide
