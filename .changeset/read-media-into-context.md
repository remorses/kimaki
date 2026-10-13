---
'kimaki': minor
---

Add the `readMediaIntoContext` tool so the agent can see images and videos saved by CLIs like ghosthand or playwriter.

Run the command that saves the file, then call the tool with its path:

```ts
readMediaIntoContext({ path: '/tmp/screen.png' })
```

The tool accepts png, jpg, gif, webp, heic, mp4, mov and webm from a path or URL, up to 20 MB. It is hidden for models without image input, and video needs a model that accepts video.
