# 🦜 Parakeet ASR Setup Complete!

## ✅ What Was Fixed

1. **Fixed default ASR provider bug** - Changed default from 'gemini' to 'parakeet' in voice.ts
2. **Rebuilt TypeScript** - Compiled the fix into dist/
3. **Started Parakeet ASR service** - Running on http://127.0.0.1:8765
4. **Created startup script** - `start-kimaki.sh` with proper configuration

---

## 🚀 How to Use Parakeet ASR

### Method 1: Use the startup script (Recommended)

```bash
cd /Users/caffae/Local-Projects-2026/kimaki
./start-kimaki.sh
```

This script:

- ✅ Sets ASR_PROVIDER=parakeet
- ✅ Verifies ASR service is running
- ✅ Starts kimaki with correct configuration

### Method 2: Set environment variable manually

```bash
export ASR_PROVIDER=parakeet
export PATH="/Users/caffae/Library/pnpm:$PATH"
kimaki
```

### Method 3: Set in shell profile

Add to `~/.zshrc`:

```bash
export ASR_PROVIDER=parakeet
export PATH="/Users/caffae/Library/pnpm:$PATH"
```

Then restart your shell and run:

```bash
kimaki
```

---

## 🧩 Managing the ASR Service

### Start ASR Service

```bash
cd /Users/caffae/Local-Projects-2026/kimaki/asr-service
python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765
```

Or in background:

```bash
cd asr-service
nohup python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765 > /tmp/asr-service.log 2>&1 &
echo $! > /tmp/asr-service.pid
```

### Stop ASR Service

```bash
kill $(cat /tmp/asr-service.pid)
```

### Check ASR Service Status

```bash
# Health check
curl http://127.0.0.1:8765/health

# Expected output:
# {"status":"healthy","model_loaded":true,"model_name":"mlx-community/parakeet-tdt-0.6b-v3"}
```

### View ASR Service Logs

```bash
tail -f /tmp/asr-service.log
```

---

## 📊 Current Status

✅ **ASR Service:** Running on http://127.0.0.1:8765

- Process ID: $(cat /tmp/asr-service.pid)
- Model: mlx-community/parakeet-tdt-0.6b-v3
- Status: Healthy

✅ **Code Fixes Applied:**

- voice.ts line 39-45: Default provider changed from 'gemini' to 'parakeet'
- TypeScript rebuilt successfully

✅ **Dependencies Installed:**

- fastapi >= 0.115.0 ✅
- uvicorn >= 0.32.0 ✅
- python-multipart >= 0.0.20 ✅
- parakeet-mlx >= 0.5.0 ✅

---

## 🔧 Environment Variables

| Variable          | Default                 | Description                               |
| ----------------- | ----------------------- | ----------------------------------------- |
| `ASR_PROVIDER`    | `parakeet`              | ASR provider: parakeet, openai, or gemini |
| `ASR_SERVICE_URL` | `http://127.0.0.1:8765` | Parakeet service URL                      |
| `OPENAI_API_KEY`  | -                       | OpenAI API key (if using OpenAI)          |
| `GEMINI_API_KEY`  | -                       | Google API key (if using Gemini)          |

---

## 🎯 Testing Parakeet Transcription

1. **Start ASR service** (already running):

   ```bash
   python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765
   ```

2. **Start kimaki** in another terminal:

   ```bash
   cd /Users/caffae/Local-Projects-2026/kimaki
   ./start-kimaki.sh
   ```

3. **Test voice transcription**:
   - Join a Discord voice channel
   - Speak and see if kimaki transcribes your voice!
   - Transcriptions appear as: "Transcribed message: [your text]"

---

## 🐛 Troubleshooting

### "Parakeet ASR service is not running"

```bash
# Check if service is running
ps aux | grep uvicorn

# Start it
cd asr-service
python3 -m uvicorn asr_server:app --host 127.0.0.1 --port 8765
```

### "Transcription failed: API call failed"

Check which provider is being used:

```bash
echo $ASR_PROVIDER
# Should output: parakeet
```

If it's not set, run:

```bash
export ASR_PROVIDER=parakeet
```

### ASR service keeps crashing

Check the logs:

```bash
tail -100 /tmp/asr-service.log
```

Common issues:

- **Port 8765 in use**: Change to another port: `--port 8766`
- **Model not loading**: Check parakeet-mlx installation: `pip list | grep parakeet`

---

## 📚️ Technical Details

### ASR Service Architecture

```
Voice Audio (Discord)
    ↓
kimaki bot (voice.ts)
    ↓
HTTP POST /transcribe/base64
    ↓
FastAPI (asr_server.py)
    ↓
parakeet-mlx model
    ↓
Transcription Text
```

### Model Information

- **Model:** NVIDIA Parakeet TDT 0.6B v3
- **Framework:** MLX (Apple Silicon optimized)
- **Language:** English (default, configurable)
- **Runtime:** Local (no API calls, no internet needed)

---

## ✅ Next Steps

1. ✅ ASR service is running
2. ✅ Code is fixed and rebuilt
3. ✅ Startup script is ready

**Start kimaki now:**

```bash
cd /Users/caffae/Local-Projects-2026/kimaki
./start-kimaki.sh
```

Then test voice transcription in Discord! 🎤
