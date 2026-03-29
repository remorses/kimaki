# Kimaki with Parakeet ASR - Quick Start

Your custom kimaki with Parakeet ASR support is already installed and ready to use!

## Installation Status

✅ **kimaki is globally available** - Just run `kimaki` from anywhere  
✅ **Parakeet is the default ASR provider** - No environment variables needed  
✅ **Linked to local project** - Changes in `/Users/caffae/Local-Projects-2026/kimaki` are active immediately

## Quick Start

### 1. Start the Parakeet ASR Service (Required for voice)

In a separate terminal:

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/asr-service
python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765
```

Or use the helper:

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/asr-service
python asr_server.py
```

### 2. Run Kimaki

```bash
kimaki
```

That's it! No environment variables, no start scripts.

## Why No Environment Variables?

The code in `voice.ts` already defaults to parakeet:

```typescript
// From voice.ts - parakeet is the default
const DEFAULT_ASR_PROVIDER = (() => {
  const env = process.env.ASR_PROVIDER?.toLowerCase()
  if (env === 'parakeet' || env === 'openai' || env === 'gemini') {
    return env as TranscriptionProvider
  }
  // Default to parakeet (local ASR) - no API key needed
  return 'parakeet' as TranscriptionProvider
})()
```

You only need to set `ASR_PROVIDER` if you want to use OpenAI or Gemini instead.

## How the Global Link Works

Your setup:

```
`kimaki` command
    ↓
/opt/homebrew/bin/kimaki (symlink)
    ↓
/opt/homebrew/lib/node_modules/kimaki/bin.js
    ↓
/Users/caffae/Local-Projects-2026/kimaki/discord (pnpm link)
    ↓
./dist/bin.js (compiled output)
```

This means:
- Running `kimaki` uses your local code
- After making changes, just run `pnpm tsc` in the discord folder
- No need to relink - it's already linked!

## Optional: Override ASR Provider

If you ever want to use a different provider:

```bash
# Use OpenAI (requires OPENAI_API_KEY)
ASR_PROVIDER=openai kimaki

# Use Gemini (requires GEMINI_API_KEY)
ASR_PROVIDER=gemini kimaki

# Default (parakeet) - just run:
kimaki
```

## Development Workflow

### Make changes:

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/discord
# Edit files...
```

### Rebuild:

```bash
pnpm tsc
```

### Test:

```bash
kimaki
```

No linking needed - already linked!

## File Locations

- **Kimaki source**: `/Users/caffae/Local-Projects-2026/kimaki/discord/src/`
- **ASR service**: `/Users/caffae/Local-Projects-2026/kimaki/asr-service/`
- **Global binary**: `/opt/homebrew/bin/kimaki`
- **Linked package**: `/opt/homebrew/lib/node_modules/kimaki`

## Troubleshooting

### "kimaki: command not found"

Check your PATH includes homebrew:

```bash
echo $PATH | grep homebrew
```

If not, add to your shell profile:

```bash
export PATH="/opt/homebrew/bin:$PATH"
```

### ASR service not running

You'll see a warning when starting kimaki. Voice transcription won't work until you start the ASR service.

### Changes not appearing

Rebuild TypeScript:

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/discord
pnpm tsc
```

## Summary

- ✅ Run `kimaki` directly - it's globally available
- ✅ No environment variables needed - parakeet is default
- ✅ Changes are live after `pnpm tsc` - no relinking needed
- ✅ Start ASR service separately for voice support
