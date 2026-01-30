# Jitter Programmatic Control Skill

Control Jitter (jitter.video) for exporting animations, replacing assets, and modifying text.

## Setup

Load utils before interacting with Jitter:

```javascript
// Load once per page (before navigation or via addInitScript)
await page.addInitScript({ path: './skills/jitter/dist/jitter-utils.js' });

// Navigate to project
await page.goto('https://jitter.video/file/?id=YOUR_FILE_ID');

// Wait for app to be ready
await page.evaluate(() => jitterUtils.waitForApp());
```

## API Reference

### Traversal

| Function | Description |
|----------|-------------|
| `findNodeById(id)` | Find node by ID |
| `findAllMediaNodes()` | Get all images/SVGs/videos/GIFs |
| `findAllTextNodes()` | Get all text nodes |
| `getArtboards()` | Get all artboards with dimensions |
| `findNodesByType(type)` | Find nodes by layer type |
| `findNodesByName(name)` | Find nodes by name (partial match) |
| `flattenTree()` | Get all nodes as flat array |

### Actions

| Function | Description |
|----------|-------------|
| `replaceAssetUrl(nodeId, url)` | Replace image/SVG/video URL |
| `replaceText(nodeId, text)` | Replace text content |
| `updateNode(nodeId, props)` | Update any node properties |
| `batchReplace(replacements)` | Batch update multiple nodes |
| `selectNodes(nodeIds)` | Select nodes by ID |
| `removeNodes(nodeIds)` | Remove nodes |
| `undo()` / `redo()` | Undo/redo actions |

### Export

| Function | Description |
|----------|-------------|
| `generateExportUrl(opts)` | Generate export URL with options |
| `generateExportUrlFromCurrentProject(opts)` | Export URL for current project |
| `parseJitterUrl(url)` | Parse file/node IDs from URL |
| `getFileMeta()` | Get current file metadata |

### Snapshot & Restore

| Function | Description |
|----------|-------------|
| `createSnapshot(nodeIds)` | Save node states |
| `restoreFromSnapshot(snapshot)` | Restore saved states |
| `duplicateProject()` | Clone current project |
| `withTemporaryChanges(nodeIds, changes, callback)` | Apply temp changes, run callback, restore |

### Waiting

| Function | Description |
|----------|-------------|
| `waitForApp(timeout?)` | Wait for app to load |
| `waitForSync(delay?)` | Wait for server sync |
| `waitForNode(nodeId, timeout?)` | Wait for node to exist |
| `isAppReady()` | Check if app is ready |

## Examples

### Replace Assets and Export

```javascript
// Get all media nodes
const media = await page.evaluate(() => jitterUtils.findAllMediaNodes());

// Replace specific assets
await page.evaluate(() => {
  jitterUtils.batchReplace([
    { nodeId: 'abc123', data: { url: 'https://example.com/new-image.svg' } },
    { nodeId: 'def456', data: { url: 'https://example.com/new-photo.jpg' } }
  ]);
});

// Wait for sync then export
await page.evaluate(() => jitterUtils.waitForSync());
const exportUrl = await page.evaluate(() => 
  jitterUtils.generateExportUrlFromCurrentProject({ profile: 'lottie' })
);
await page.goto(exportUrl);
```

### Export with Temporary Changes

```javascript
await page.evaluate(async () => {
  const nodeIds = ['node1', 'node2'];
  const changes = {
    'node1': { url: 'https://temp-asset.svg' },
    'node2': { text: 'Temporary Text' }
  };
  
  await jitterUtils.withTemporaryChanges(nodeIds, changes, async () => {
    // Changes applied here, will be restored after
    const url = jitterUtils.generateExportUrlFromCurrentProject();
    // ... navigate to export URL and download
  });
  // Original values automatically restored
});
```

### Find and Update Text

```javascript
const textNodes = await page.evaluate(() => jitterUtils.findAllTextNodes());
// [{ id, name, text, fontSize, fontFamily }, ...]

await page.evaluate(() => {
  jitterUtils.replaceText('textNodeId', 'New headline');
});
```

## Export Profiles

| Profile | Output |
|---------|--------|
| `lottie` | Lottie JSON (vector animation) |
| `mp4` | H.264 video |
| `gif` | Animated GIF |
| `webm` | WebM video |
| `prores4444` | ProRes 4444 (with alpha) |
| `pngs` | PNG sequence |

## Lottie Export Limitations

- **NodeIds are NOT preserved** in exported Lottie - cannot map back to Jitter nodes
- **Text becomes shapes** - not editable Lottie text layers
- **Images are embedded** as base64, no external URLs
- **Videos** export as first frame only

**Workaround:** Always modify assets in Jitter before export using `replaceAssetUrl()`.

## Tips

1. **Wait for sync** after modifications before exporting (1-2 seconds)
2. **Asset URLs** must be publicly accessible - Jitter fetches server-side
3. All `*WithUndo` actions can be undone with Ctrl+Z
4. Node IDs are stable and bookmarkable via `?nodeId=xxx`
5. Export URLs require being logged in with project access
