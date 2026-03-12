---
name: egaki
description: >
  AI image generation CLI. Generates images from text prompts using Google Imagen
  and Gemini multimodal models via the Vercel AI SDK. Supports image editing,
  inpainting, and multiple output formats.
---

# egaki

AI image generation from the terminal. Text-to-image, image editing, and inpainting
with Google Imagen and Gemini models.

Run `egaki --help` before using this CLI. The help output has all commands,
options, defaults, and usage examples.

For subcommand details: `egaki <command> --help` (e.g. `egaki image --help`, `egaki login --help`)

## Quick start

```bash
# configure an API key
egaki login

# generate an image
egaki image "a sunset over mars"

# edit an existing image (local file or URL)
egaki image "add a wizard hat" --input photo.jpg
egaki image "make it pop art" --input https://example.com/photo.jpg

# pipe to another tool
egaki image "logo" --stdout | convert - -resize 512x512 logo.png
```

