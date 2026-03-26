#!/usr/bin/env python3
"""
ASR Service - FastAPI wrapper for parakeet-mlx
Provides HTTP API for speech-to-text transcription using NVIDIA Parakeet on Apple Silicon.
"""

import os
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile, Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Lazy import parakeet-mlx to allow service to start without model preloaded
parakeet_model: Optional[object] = None

app = FastAPI(
    title="Parakeet MLX ASR Service",
    description="Speech-to-text transcription using NVIDIA Parakeet on Apple Silicon",
    version="1.0.0",
)


class TranscriptionResponse(BaseModel):
    """Response model for transcription."""
    text: str
    duration: Optional[float] = None
    language: Optional[str] = None


class HealthResponse(BaseModel):
    """Response model for health check."""
    status: str
    model_loaded: bool
    model_name: str


def get_model():
    """Lazy load the parakeet-mlx model."""
    global parakeet_model
    if parakeet_model is None:
        try:
            from parakeet_mlx import from_pretrained
            
            model_name = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
            print(f"Loading parakeet-mlx model: {model_name}")
            parakeet_model = from_pretrained(model_name)
            print(f"Model loaded successfully")
        except Exception as e:
            print(f"Failed to load model: {e}")
            raise
    return parakeet_model


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Check if the service and model are healthy."""
    model = None
    try:
        model = get_model()
    except Exception:
        pass
    
    model_name = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
    
    return HealthResponse(
        status="healthy" if model else "degraded",
        model_loaded=model is not None,
        model_name=model_name,
    )


@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    language: Optional[str] = None,
):
    """
    Transcribe audio file to text.
    
    Args:
        file: Audio file (WAV, MP3, OGG, M4A, etc.)
        language: Optional language hint (e.g., "en")
    
    Returns:
        JSON with transcription text, duration, and detected language
    """
    # Validate file type
    allowed_extensions = {".wav", ".mp3", ".ogg", ".m4a", ".flac", ".aac"}
    file_ext = Path(file.filename or "").suffix.lower()
    
    if file_ext not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type: {file_ext}. Allowed: {allowed_extensions}"
        )
    
    # Save uploaded file to temp location
    with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    
    try:
        # Load model and transcribe
        model = get_model()
        
        # Run transcription
        result = model.transcribe(tmp_path)
        
        return TranscriptionResponse(
            text=result.text,
            duration=result.sentences[0].end if result.sentences else None,
            language=language or "en",  # Default to English
        )
        
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {str(e)}"
        )
    finally:
        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@app.post("/transcribe/base64", response_model=TranscriptionResponse)
async def transcribe_audio_base64(
    audio_data: str = Body(..., description="Base64 encoded audio"),
    media_type: str = Body("audio/wav", description="MIME type of audio"),
    language: Optional[str] = Body(None, description="Language hint"),
):
    """
    Transcribe base64-encoded audio to text.
    
    Args:
        audio_data: Base64-encoded audio data
        media_type: MIME type of the audio (default: audio/wav)
        language: Optional language hint
    
    Returns:
        JSON with transcription text
    """
    import base64
    
    # Determine file extension from media type
    ext_map = {
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp3": ".mp3",
        "audio/mpeg": ".mp3",
        "audio/ogg": ".ogg",
        "audio/opus": ".ogg",
        "audio/mp4": ".m4a",
        "audio/m4a": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/flac": ".flac",
        "audio/aac": ".aac",
    }
    file_ext = ext_map.get(media_type.lower(), ".wav")
    
    try:
        audio_bytes = base64.b64decode(audio_data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 data: {e}")
    
    # Write to temp file
    with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    
    try:
        model = get_model()
        result = model.transcribe(tmp_path)
        
        return TranscriptionResponse(
            text=result.text,
            duration=result.sentences[0].end if result.sentences else None,
            language=language or "en",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    
    port = int(os.environ.get("ASR_PORT", "8765"))
    host = os.environ.get("ASR_HOST", "127.0.0.1")
    
    print(f"Starting ASR service on {host}:{port}")
    print(f"Model: {os.environ.get('PARAKEET_MODEL', 'mlx-community/parakeet-tdt-0.6b-v3')}")
    
    uvicorn.run(app, host=host, port=port)
