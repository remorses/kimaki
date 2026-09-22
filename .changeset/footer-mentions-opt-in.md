---
'kimaki': minor
---

Make footer mentions opt-in. Final session footers no longer ping the thread creator by default. Pass `--enable-footer-mentions` to get the old behavior:

```bash
kimaki --enable-footer-mentions
```

The old `--skip-footer-mentions` flag is removed. If you used it, just drop it, since no mention is now the default.
