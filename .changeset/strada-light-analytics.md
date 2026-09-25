---
'kimaki': patch
---

Use the zero-dependency `@strada.sh/sdk` for anonymous analytics. This removes about 12 MB of OpenTelemetry dependencies from the install. The analytics SDK no longer installs its own `uncaughtException` handler, which called `process.exit(1)` and could end the bot before Kimaki's own crash handler finished.
