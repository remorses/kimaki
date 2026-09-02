---
'kimaki': patch
'@subrouter/cli': patch
---

Fix Claude Pro and Max requests that Anthropic rejected because they identified as an old Claude Code release.

Kimaki and Subrouter now use the current official Claude Code client identity for OAuth account lookups and model requests.
