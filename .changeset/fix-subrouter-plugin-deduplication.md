---
'kimaki': patch
---

Prevent `@subrouter/opencode` from loading twice when it is configured by both Kimaki and the user.

Published Kimaki builds now register the exact npm package version instead of a `file://` path. OpenCode deduplicates plugin declarations by npm package name, so global, project, and Kimaki declarations resolve to one plugin load. Local Kimaki development still loads the workspace package directly.
