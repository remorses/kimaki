---
title: Jitter Export Pipeline Internals
description: |
  Reverse-engineered architecture of Jitter's export and rendering pipeline.
  Covers the headless renderer page, scene graph format, network requests,
  bundle structure, and feasibility of building a standalone local exporter.
prompt: |
  Analyze the jitter skill. Try it in the playwriter. Then analyze the
  JavaScript code that runs in the exporter page. Think about extracting
  the JavaScript bundle to create a standalone local exporter for AI agents.
  Examine network requests, download the bundle, see where the data for the
  scene graph comes from and how we would override it.
  Files read: @discord/skills/jitter/SKILL.md @discord/skills/jitter/EDITOR.md
  @discord/skills/jitter/utils/export.ts @discord/skills/jitter/utils/wait.ts
  @discord/skills/jitter/utils/types.ts @discord/skills/jitter/utils/traverse.ts
  @discord/skills/jitter/utils/actions.ts
  Used Playwriter to navigate to jitter.video, open a real project, inspect
  window.app, download all JS chunks, and intercept network requests on the
  /api/renderer/ page.
---

# Jitter Export Pipeline Internals

## Architecture Overview

Jitter is a **Gatsby (React) SPA**. Three pages are relevant to export:

| Page | Path | Role |
|------|------|------|
| Editor | `/file/?id=` | Interactive editor, stores scene graph in `window.app` |
| Export UI | `/export/` | Plan-limit checks, delegates to renderer |
| **API Renderer** | `/api/renderer/` | **Headless rendering engine** — the key page |

The API Renderer page renders **nothing visible** (`render() { return null }`).
It exists solely to be driven by an external process (Puppeteer/Playwright on
Jitter's servers) that calls `window.jitter.renderFrame(time)` in a loop.

```
┌─────────────────────────────────────────────────────────┐
│  Jitter's export backend (server-side Puppeteer)        │
│                                                         │
│  1. Open /api/renderer/?file=X&artboardId=Y&width=...   │
│  2. Wait for jitterLoadEvent {name:"ready"}             │
│  3. Loop: window.jitter.renderFrame(t) → PNG string     │
│  4. Pipe PNGs to FFmpeg → MP4/WebM/GIF                  │
│  5. Upload result to S3, return download link            │
└─────────────────────────────────────────────────────────┘
```

## The API Renderer Page

**Source:** `component---src-pages-api-renderer-ts` (3KB, all logic delegated
to modules in `app.js`)

**URL params** (all required):

| Param | Type | Description |
|-------|------|-------------|
| `file` | string | Project/file ID |
| `bucket` | string | S3 bucket name (e.g. `snackthis-userdata`) |
| `artboardId` | string | Which artboard to render |
| `width` | number | Export width in px |
| `height` | number | Export height in px |
| `noBg` | boolean | Transparent background |
| `addWatermark` | boolean | Add Jitter watermark |
| `superSampling` | number | Render at higher res then downsample |
| `playbackDirection` | string | `normal`, `reverse`, or `boomerang` |
| `vfe` | string | Video fallback export (`on`/`off`) |

**Lifecycle:**

1. Parses and Zod-validates URL params
2. Loads project data: `GM(fileId, bucket)` — tries IndexedDB cache first,
   then S3/CloudFront
3. Finds the artboard in the loaded project
4. Creates a **scene** object (resolves assets, builds render tree)
5. Creates a **canvas renderer** (Canvas 2D, not WebGL)
6. Sets `window.jitter`:
   - `exportContext: { exportWidth, exportHeight, exportDuration }`
   - `renderFrame(time)` → renders frame, returns `{ name: "frame", t, pngString, ...exportContext }`
   - `wav` → audio data as number array (or undefined)
7. Dispatches `CustomEvent("jitterLoadEvent", { detail: { name: "ready", ...exportContext } })`
8. On error dispatches `{ name: "error", message }`

## Scene Graph Format

The project configuration lives at
`window.app.props.observableImmutableConf.lastImmutableConf`.

Top-level structure:

```json
{
  "nodes": {},
  "roots": [
    {
      "id": "artboard-id",
      "item": {
        "type": "artboard",
        "width": 1080,
        "height": 1080,
        "duration": 8000,
        "fillColor": "#ffffff",
        "background": true
      },
      "children": [
        { "id": "...", "item": { "type": "operationsTree" }, "children": [...] },
        { "id": "...", "item": { "type": "layersTree" }, "children": [...] }
      ]
    }
  ]
}
```

### Layer types

| Type | Key properties |
|------|---------------|
| `artboard` | `width`, `height`, `duration`, `fillColor`, `background` |
| `layersTree` | Container for visual layers |
| `operationsTree` | Container for animation operations |
| `opGrp` | Named animation step (e.g. "Step 1") |
| `layerGrp` | Visual group, `clipsContent`, `cornerRadius` |
| `image` | `url` (CloudFront), `width`, `height`, `cornerRadius` |
| `video` | `url`, `audioUrl`, `width`, `height` |
| `svg` | `url` |
| `gif` | `url` |
| `text` | `text`, `font`, `fontSize`, `fillColor`, `textAlign` |
| `rect` | `fillColor`, `cornerRadius`, `strokeColor` |
| `ellipse` | `fillColor` |
| `star` | `fillColor`, `points`, `innerRadius` |

All layers share: `x`, `y`, `width`, `height`, `angle`, `scale`, `opacity`,
`shadowEnabled`, `strokeEnabled`.

### Animation operations

Operations live under `operationsTree > opGrp` nodes. Each operation targets
a layer by `targetId`:

```json
{
  "type": "move",
  "targetId": "layer-id",
  "startTime": 1000,
  "endTime": 2000,
  "toValue": { "moveX": -530, "moveY": 0 },
  "easing": {
    "name": "smooth:standard:v1",
    "schema": "v1",
    "config": { "intensity": 85 }
  }
}
```

Animation types: `move`, `scale`, `rotate`, `opacity`, `fadeIn/Out`,
`growIn/Out`, `shrinkIn/Out`, `slideIn/Out`, `spinIn/Out`, `blurIn/Out`,
`textIn/Out`, `maskRevealIn/Out`, `maskSlideIn/Out`, `maskCenterIn/Out`,
`playVideo`, `playAudio`.

### Asset URLs

All media assets are served from CloudFront:

```
https://d154zarmrcpu4a.cloudfront.net/{assetId}.png
https://d154zarmrcpu4a.cloudfront.net/{assetId}.mp4
```

Project data (the conf JSON) is stored at:

```
https://d2q1h0g8a6snwf.cloudfront.net/{encodedFileId}
```

The `d2q1h0g8a6snwf` URL is for the `snackthis-userdata` bucket.
Other buckets use `(0,u.T8)(bucket, fileId)` to construct the URL.

## Network Requests During Export

Requests made when the `/api/renderer/` page loads:

**Static assets (cached):**
- `webpack-runtime-*.js` (11KB)
- 6 shared chunks (~970KB total)
- `app.js` (3.0MB) — contains the entire renderer
- `api-renderer-*.js` (3KB)
- Page data JSONs from Gatsby

**Data fetches:**
- `backend2.jitter.video/get-user-infos` — user profile
- `backend2.jitter.video/get-subscription` — plan info
- `backend2.jitter.video/teams/get-all-subscriptions`
- `backend2.jitter.video/realtime/get-token` — WebSocket auth token

**Project data:** loaded from IndexedDB cache if the user recently visited the
editor, otherwise fetched from S3/CloudFront.

**No rendering API calls** — all rendering is 100% client-side on Canvas 2D.

## JS Bundle Structure

| File | Size | Purpose |
|------|------|---------|
| `app-*.js` | **3.0MB** | Core: renderer, scene builder, all shared modules |
| `editor-page (file-*.js)` | 960KB | Editor UI (not needed for export) |
| `22016225-*.js` | 176KB | Shared chunk |
| `3caaf7ec-*.js` | 168KB | Shared chunk |
| `42b3359b-*.js` | 316KB | Shared chunk |
| `4fa16633-*.js` | 124KB | Shared chunk (canvas/WebGL refs) |
| `146c69ca-*.js` | 62KB | Shared chunk |
| `f27202df-*.js` | 116KB | Shared chunk |
| `api-renderer-*.js` | **3KB** | Glue: parse params → create scene → expose `window.jitter` |
| `webpack-runtime-*.js` | 11KB | Module loader |

Total for rendering: ~4.8MB of JavaScript.

### Key webpack modules (inside app.js)

| Module ID | Export | Purpose |
|-----------|--------|---------|
| 65031 | `GM` (as `L`) | Project loader: IndexedDB → S3/CloudFront fallback |
| 82106 | `h` (as `b`) | Scene creation: conf → scene object with asset store |
| 89018 | `UH` (as `a`) | Renderer factory: scene → `{ canvas, renderFrame, duration }` |
| 66868 | `HX` (as `Z`) | Core frame render: `(scene, time, canvasCtx) → void` |
| 82755 | `eM` | Canvas to PNG string conversion |
| 44852 | `vS` | Artboard finder in project tree |
| 94533 | `Mj` | Audio track extraction |
| 61904 | `ev` | Canvas context creation at given dimensions |

## Renderer Internals

The renderer factory (module 89018) creates a closure:

```
function createRenderer(scene, width, height, superSampling, options):
  canvas = createCanvasContext(width, height)
  if superSampling > 1:
    create chain of progressively smaller canvases for downscaling
  
  return {
    canvas: canvas.canvas,
    duration: computeDuration(scene.duration, playbackDirection),
    renderFrame: async (time) => {
      adjustedTime = applyPlaybackDirection(time)
      coreRender(scene, adjustedTime, canvas)  // module 66868.HX
    }
  }
```

Scene creation (module 82106) takes the raw conf and:
1. Resolves the camera/viewport for the selected artboards
2. Optionally applies imgix transforms for super-sampled images
3. Optionally strips audio or backgrounds
4. Loads all assets into an `assetStore` (Map of asset ID → loaded asset)
5. Creates a `prepass` function (prepares frame) and `render` function (draws frame)

## Standalone Local Exporter: Feasibility

### What would be needed

```
┌──────────────────────────────────────────────────┐
│  Local index.html                                │
│                                                  │
│  ┌─────────────┐   ┌──────────────────────────┐  │
│  │ Scene JSON  │──▸│ Jitter Renderer Engine   │  │
│  │ (uploaded)  │   │ (extracted from app.js)  │  │
│  └─────────────┘   │ scene → canvas → frames  │  │
│                     └───────────┬──────────────┘  │
│                                 ▼                 │
│                     ┌──────────────────────────┐  │
│                     │ Frame capture + encode   │  │
│                     │ MediaRecorder/WebCodecs  │  │
│                     └───────────┬──────────────┘  │
│                                 ▼                 │
│                     ┌──────────────────────────┐  │
│                     │ MP4/WebM output file     │  │
│                     └──────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Assessment by component

| Component | Difficulty | Notes |
|-----------|-----------|-------|
| Bundle extraction | Hard | 3MB minified webpack bundle, ~15 transitive module deps |
| Project data override | Easy | Replace `GM()` loader with local JSON injection |
| Asset hosting | Easy | Download CloudFront assets, rewrite URLs or use service worker |
| Auth bypass | Easy | Mock `/get-user-infos`, `/get-subscription` — rendering is client-side |
| Video encoding | Medium | WebCodecs API, MediaRecorder, or FFmpeg.wasm |
| Legal/ToS compliance | **Blocker** | Extracting and redistributing Jitter's code likely violates ToS |

### Practical alternatives

1. **Use Playwright to drive `/api/renderer/` directly** — this is exactly
   what Jitter's own backend does. Navigate, wait for ready event, call
   `renderFrame()` in a loop, pipe frames to FFmpeg. No extraction needed.

2. **Build a custom renderer** using the scene format as a spec. The JSON
   format is well-understood. Libraries like `lottie-web`, `rive`, or a
   custom Canvas 2D renderer could interpret the same format.

3. **Use the editor + Playwriter skill** — the existing jitter skill already
   supports: modify scene → generate export URL → navigate → download. This
   works today.

4. **Request an API/self-hosted tier from Jitter** — their architecture
   already has an `api/renderer` page designed for programmatic use.
