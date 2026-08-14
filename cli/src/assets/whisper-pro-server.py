# Kimaki Whisper Pro server — faster-whisper behind a minimal OpenAI-compatible API.
# Provisioned automatically by `/whisper-setup model: Pro`; managed by
# `/whisper-start|stop|status`. Not intended to be run by hand.
#
#   GET  /health                     -> {"ok": true, "model": ..., "device": ...}
#   POST /v1/audio/transcriptions    -> {"text": ...}   (multipart: file)
#
# Device: tries CUDA first (cuDNN/cuBLAS wheels installed by the provisioner),
# falls back to CPU int8. On Windows the nvidia wheel DLL dirs are registered
# here via os.add_dll_directory before ctranslate2 loads.
import argparse
import os
import sys
import site


def register_windows_cuda_dlls() -> None:
    if sys.platform != "win32":
        return
    for packages_dir in site.getsitepackages():
        nvidia_root = os.path.join(packages_dir, "nvidia")
        if not os.path.isdir(nvidia_root):
            continue
        for pkg in os.listdir(nvidia_root):
            for sub in ("bin", "lib"):
                dll_dir = os.path.join(nvidia_root, pkg, sub)
                if os.path.isdir(dll_dir):
                    os.add_dll_directory(dll_dir)


register_windows_cuda_dlls()

from fastapi import FastAPI, UploadFile, File  # noqa: E402
import numpy as np  # noqa: E402
import uvicorn  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=7071)
parser.add_argument("--model", type=str, default="large-v3")
args = parser.parse_args()


def load_model() -> tuple[WhisperModel, str]:
    try:
        model = WhisperModel(args.model, device="cuda", compute_type="float16")
        # Force lazy CUDA init now so a broken CUDA setup fails here, not mid-request.
        list(model.transcribe(np.zeros(16000, dtype=np.float32), language="en")[0])
        return model, "cuda"
    except Exception as exc:  # noqa: BLE001 — any CUDA failure falls back to CPU
        print(f"CUDA unavailable ({exc}); using CPU int8", flush=True)
        return WhisperModel(args.model, device="cpu", compute_type="int8"), "cpu"


print(f"Loading {args.model} (first run downloads the model)…", flush=True)
model, device = load_model()
print(f"Model ready on {device}", flush=True)

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "model": args.model, "device": device}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...)):
    import io

    data = await file.read()
    segments, _info = model.transcribe(io.BytesIO(data), vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {"text": text}


uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
