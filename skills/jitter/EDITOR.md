# Jitter Editor API Reference

Reference for `window.app` methods and layer types. For utilities, see SKILL.md and use `jitterUtils.*`.

## App Instance Methods

```javascript
// Playback
app.play();
app.stopPlayback();
app.moveCursor(timeInMs);

// Layer creation (opens picker or adds at cursor)
app.addArtboard();
app.addText("toolbar");
app.addRectShape("toolbar");
app.addEllipseShape("toolbar");
app.addMedia("toolbar");

// File operations
app.renameFile(newName);
app.deleteFile();
app.downloadProject();
app.scheduleSave();
```

## Dispatch Actions

Use `app.dispatchAction(action)` or `jitterUtils.*` helpers.

### Core Actions

| Action Type | Purpose |
|-------------|---------|
| `updateObjWithUndo` | Update node properties |
| `addObjWithUndo` | Add new node |
| `removeObjWithUndo` | Remove nodes |
| `setSelection` | Select nodes |
| `emptySelection` | Clear selection |
| `undo` / `redo` | Undo/redo |
| `setCurrentTime` | Set playhead time |
| `zoomToSelection` | Zoom to selected |

## Layer Types

### Artboard
```javascript
{
  type: "artboard",
  name: "16:9",
  width: 1920,
  height: 1080,
  duration: 11000,
  background: true,
  fillColor: "#ffffff"
}
```

### Text
```javascript
{
  type: "text",
  text: "Hello World",
  fontSize: 48,
  font: { name: "Poppins", type: "googlefont", weight: 600 },
  fillColor: "#000000",
  textAlign: "center",  // "left" | "center" | "right"
  verticalAlign: "middle"
}
```

### Image / SVG / Video / GIF
```javascript
{
  type: "image",  // or "svg", "video", "gif"
  url: "https://example.com/asset.jpg",
  width: 400,
  height: 300,
  cornerRadius: 0
}
```

### Shapes
```javascript
// Rectangle
{ type: "rect", fillColor: "#3B82F6", cornerRadius: 8 }

// Ellipse
{ type: "ellipse", fillColor: "#EF4444" }

// Star
{ type: "star", fillColor: "#F59E0B", points: 5, innerRadius: 50 }
```

### Group
```javascript
{
  type: "layerGrp",
  name: "Group Name",
  clipsContent: false,
  cornerRadius: 0
}
```

## Common Properties

All layers support:

| Property | Type | Description |
|----------|------|-------------|
| `x`, `y` | number | Position |
| `width`, `height` | number | Size |
| `angle` | number | Rotation in degrees |
| `scale` | number | Scale factor |
| `opacity` | number | 0-100 |
| `shadowEnabled` | boolean | Drop shadow |
| `strokeEnabled` | boolean | Stroke/border |

## Fill Colors

```javascript
// Solid
fillColor: "#3B82F6"

// Linear gradient
fillColor: {
  type: "GRADIENT_LINEAR",
  stops: [
    { id: "s1", position: 0, color: "#FF0000" },
    { id: "s2", position: 1, color: "#0000FF" }
  ],
  transform: { angle: 0, sx: 1, tx: 0.5, ty: 0.5 }
}

// Radial gradient
fillColor: {
  type: "GRADIENT_RADIAL",
  stops: [...],
  transform: { sx: 1, tx: 0.5, ty: 0.5 }
}
```

## Easing Presets

```javascript
{ name: "smooth:standard:v1", schema: "v1", config: { intensity: 50 } }
{ name: "smooth:accelerate:v1", schema: "v1", config: { intensity: 50 } }
{ name: "smooth:decelerate:v1", schema: "v1", config: { intensity: 50 } }
{ name: "spring", schema: "v1", config: { stiffness: 100, damping: 10 } }
{ name: "bounce", schema: "v1", config: { bounces: 3 } }
{ name: "linear", schema: "v1", config: {} }
```

## Animation Types

### Transform
`scale`, `move`, `rotate`, `opacity`

### Enter/Exit
`fadeIn/Out`, `growIn/Out`, `shrinkIn/Out`, `slideIn/Out`, `spinIn/Out`, `blurIn/Out`, `textIn/Out`

### Mask
`maskRevealIn/Out`, `maskSlideIn/Out`, `maskCenterIn/Out`

### Media
`playVideo`, `playAudio`

## Node Tree Structure

```
Artboard (type: "artboard")
├── LayersTree (type: "layersTree")
│   ├── LayerGrp (type: "layerGrp")
│   │   ├── Text (type: "text")
│   │   └── Image (type: "image")
│   └── SVG (type: "svg")
└── OperationsTree (type: "operationsTree")
    └── OpGrp (type: "opGrp")
        ├── Scale animation
        └── FadeIn animation
```

## State Access

```javascript
// Current selection
const state = app.props.observableEditorState.getSnapshot();
const selectedIds = state.selection.nodesIds;

// Project config
const conf = app.props.observableImmutableConf.lastImmutableConf;

// File metadata
const fileMeta = app.props.fileMeta;
// { id, name, bucket, teamId }

// Subscribe to changes
const unsubscribe = app.props.observableImmutableConf.subscribe(() => {
  // Config changed
});
```

## File Actions

```javascript
await app.props.fileActions.duplicateFile(fileId);  // Returns new ID
await app.props.fileActions.deleteFile(fileId);
await app.props.fileActions.renameFile(name);
await app.props.fileActions.saveFile();
```
