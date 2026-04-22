---
name: egaki
description: >
  AI image and video generation CLI. Use this skill to install egaki, configure
  auth, run help commands, and generate images or videos with provider keys or
  an Egaki subscription.
---

# egaki

Generate AI images and videos from the terminal.
Use this for text-to-image, image editing, mask-based edits, text-to-video,
image-to-video, and model discovery.

## Install

```bash
pnpm add -g egaki
```

## Always check help first

Run the full help output before using commands:

```bash
egaki --help
```

Do not truncate help output with `head`.

For subcommand details: `egaki <command> --help` (e.g. `egaki image --help`, `egaki video --help`, `egaki login --help`)

## Auth options

You can authenticate in two ways:

1. Egaki subscription key (recommended — all models, one key)
2. Provider API keys (Google, OpenAI, Fal, Replicate) via `egaki login`

If using Egaki subscription, set it up first with `egaki subscribe`, then store
the key with `egaki login --provider egaki --key egaki_...`.

## Login behavior for remote agents

When login requires a URL flow, run login in the background and send the login URL
to the user so they can complete auth interactively.

## Example commands

```bash
# configure key interactively
egaki login

# show login status
egaki login --show

# subscribe to Egaki for all supported models
egaki subscribe

# check subscription usage
egaki usage

# generate an image
egaki image "a watercolor fox reading a map" -o fox.png

# select a model explicitly
egaki image "isometric floating city, soft colors" -m imagen-4.0-generate-001 -o city.png

# edit an existing image (local file or URL)
egaki image "add a red scarf and make it winter" --input portrait.jpg -o portrait-winter.png
egaki image "turn this into a manga panel" --input https://example.com/photo.jpg -o manga.png

# inpainting with a mask
egaki image "replace the sky with a dramatic sunset" --input scene.png --mask mask.png -o scene-sunset.png

# generate a video — use a 5 minute timeout, video generation is slow
egaki video "a paper boat drifting on a calm lake at sunrise" -o boat.mp4

# generate a video with a specific model
egaki video "timelapse of a stormy sea, cinematic" -m google/veo-3.1-fast-generate-001 --duration 6 -o storm.mp4

# cheap video model
egaki video "a cat walking on a rooftop at night" -m klingai/kling-v2.5-turbo-t2v --duration 5 -o cat.mp4

# image-to-video (model must support i2v)
egaki video "slowly animate the clouds" --input photo.jpg -m klingai/kling-v2.6-i2v -o animated.mp4

# discover all models (image + video)
egaki models

# filter by type
egaki models --type video
egaki models --type image
```

## Video generation note for agents

Video generation can be very slow — some models take 1–3 minutes per request.
Always use a command timeout of **at least 5 minutes** when invoking `egaki video`
from automation or agent workflows.
