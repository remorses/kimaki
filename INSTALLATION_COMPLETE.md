# Kimaki Installation Complete! 🎉

Your modified kimaki with Parakeet ASR support is installed and ready to use.

## Quick Start

### 1. Start the Parakeet ASR Service (for voice channels)

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/asr-service
python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765
```

Keep this running in a separate terminal.

### 2. Run Kimaki

```bash
kimaki
```

That's it! No environment variables needed.

## What's Installed

- **kimaki** - Available globally as `kimaki` command
- **Parakeet ASR** - Default transcription provider (local, no API key)
- **Source** - `/Users/caffae/Local-Projects-2026/kimaki/discord`

## How to Use

Just run `kimaki` from anywhere:

```bash
kimaki
```

This starts the setup wizard to:
1. Create/link your Discord bot
2. Install the bot to your server
3. Configure voice channels (optional)

## Development

After making changes to the code:

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/discord
pnpm tsc  # Rebuild
kimaki    # Test changes
```

No linking needed - it's already globally linked!

## Optional Environment Variables

Parakeet is the **default** ASR provider. You only need these if you want to use a cloud provider:

```bash
# Use OpenAI instead of Parakeet
ASR_PROVIDER=openai OPENAI_API_KEY=xxx kimaki

# Use Gemini instead of Parakeet
ASR_PROVIDER=gemini GEMINI_API_KEY=xxx kimaki
```

## File Structure

```
kimaki/
├── discord/              # Main kimaki package
│   ├── src/              # TypeScript source
│   ├── dist/             # Compiled JavaScript
│   └── bin.js            # Entry point
├── asr-service/          # Parakeet ASR server
│   ├── asr_server.py
│   └── requirements.txt
└── README_PARAKEET_SETUP.md  # Detailed setup guide
```

## Troubleshooting

### Command not found

```bash
# Ensure homebrew bin is in PATH
export PATH="/opt/homebrew/bin:$PATH"
```

### ASR service not running

Voice transcription requires the ASR service. Start it with:

```bash
cd asr-service && python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765
```

### TypeScript errors after changes

```bash
cd discord
pnpm tsc  # Check for errors
```

## Summary

- ✅ `kimaki` command works globally
- ✅ Parakeet ASR is the default (no env vars needed)
- ✅ Changes are live after `pnpm tsc`
- ✅ ASR service runs separately for voice support

See **README_PARAKEET_SETUP.md** for more details.
