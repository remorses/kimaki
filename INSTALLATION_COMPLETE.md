# Kimaki Installation Complete! 🎉

Your modified version of kimaki with Parakeet ASR support has been successfully built and installed.

## Installation Summary

✅ **Fixed Issues:**

1. Initialized git submodules (traforo, errore, gateway-proxy)
2. Built workspace packages (traforo, errore from source)
3. Generated Prisma clients for database layer
4. Fixed TypeScript compilation error in voice.ts
5. Built TypeScript to dist/ folder
6. Linked globally with pnpm

✅ **Build Status:**

- TypeScript: Built successfully (187 JS files in dist/)
- Binary: `/Users/caffae/Library/pnpm/kimaki`
- Version: 0.4.77
- Parakeet ASR: ✅ Integrated

## How to Use

### Method 1: Using the pnpm-linked binary (Recommended)

The kimaki binary is available at:

```
/Users/caffae/Library/pnpm/kimaki
```

Your PATH already includes `/Users/caffae/Library/pnpm`, so you can run:

```bash
kimaki
```

If the command isn't found, ensure your shell has the PATH set:

```bash
export PATH="/Users/caffae/Library/pnpm:$PATH"
```

### Method 2: From the project directory

```bash
cd /Users/caffae/Local-Projects-2026/kimaki
pnpm kimaki
```

### Method 3: Using tsx directly (development)

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/discord
pnpm dev
```

## Your Parakeet Modifications

Your modifications include:

- ✅ Parakeet-mlx local ASR integration
- ✅ Auto-start Parakeet ASR service with kimaki
- ✅ New `asr-service/` directory with `asr_server.py`

### Setting up Parakeet ASR

To use Parakeet for speech-to-text:

1. **Install Python dependencies:**

   ```bash
   cd asr-service
   pip install -r requirements.txt
   ```

2. **Start the ASR server:**

   ```bash
   python asr_server.py
   ```

3. **Run kimaki with voice channels enabled:**

   ```bash
   kimaki --enable-voice-channels
   ```

4. **Set ASR provider to parakeet:**
   - The ASR service URL defaults to `http://127.0.0.1:8765`
   - Set environment variable: `ASR_PROVIDER=parakeet`
   - Or configure in voice channel settings

### Parakeet ASR Server Details

- **Server Location:** `asr-service/asr_server.py`
- **Default Port:** 8765
- **Endpoint:** `POST /transcribe/base64`
- **Input:** Base64-encoded audio data
- **Output:** `{ "text": "transcription result" }`

## First Run

Run the setup wizard:

```bash
kimaki
```

This will guide you through:

1. Creating a Discord bot
2. Configuring bot settings
3. Installing the bot to your server
4. Selecting projects to connect

## Development Notes

### To rebuild after changes:

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/discord
pnpm tsc  # Rebuild TypeScript to dist/
```

### To relink after rebuild:

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/discord
pnpm link --global
```

## File Structure

```
kimaki/
├── asr-service/          # Your Parakeet ASR service
│   ├── asr_server.py     # Main ASR server
│   ├── requirements.txt   # Python dependencies
│   └── README.md        # ASR service docs
├── discord/             # Main kimaki package
│   ├── dist/            # Built JavaScript (187 files)
│   ├── src/             # TypeScript source
│   └── bin.js           # Entry point
├── errore/             # Error handling library (submodule)
└── traforo/            # Tunnel library (submodule)
```

## Troubleshooting

### Command not found

If `kimaki` isn't found:

```bash
export PATH="/Users/caffae/Library/pnpm:$PATH"
kimaki --version
```

### ASR service not running

If you get "Parakeet ASR service is not running":

```bash
cd asr-service
pip install -r requirements.txt
python asr_server.py
```

### TypeScript errors after changes

```bash
cd discord
pnpm tsc  # Check for errors
pnpm generate  # Regenerate Prisma client
```

## Next Steps

1. Start the Parakeet ASR service in a separate terminal
2. Run `kimaki --enable-voice-channels`
3. Create a voice channel in Discord
4. Test voice transcription!

## Version Info

- **Kimaki Version:** 0.4.77
- **Node Version:** v25.6.1
- **Platform:** darwin-arm64
- **ASR Provider:** Parakeet-mlx (local)
- **Build Date:** March 16, 2026

---

**Your modified kimaki is ready to use!** 🚀

All your Parakeet ASR modifications have been integrated and the bot can now transcribe voice messages using local NVIDIA Parakeet models.
