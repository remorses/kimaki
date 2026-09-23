---
'kimaki': patch
---

Fix Anthropic sessions crashing with `undefined is not an object (evaluating 'auth.type')` after Claude Pro/Max login is removed.

OpenCode can still call the cached OAuth fetch after `auth.json` no longer has an `anthropic` entry. Kimaki now reports that the login is missing instead of throwing on `auth.type`.

Re-login with `/login` and pick **Claude Pro/Max** before using an `anthropic/*` model again.
