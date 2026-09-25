---
'kimaki': patch
---

Use `@strada.sh/light` for anonymous analytics instead of the full `@strada.sh/sdk`. This removes about 12 MB of OpenTelemetry dependencies from the install. It also stops the analytics SDK from installing its own `uncaughtException` handler, which called `process.exit(1)` and could end the bot before Kimaki's own crash handler finished.
