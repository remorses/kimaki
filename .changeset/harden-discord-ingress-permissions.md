---
'kimaki': patch
---

Harden Discord ingress permission checks so uncached guild members fail closed instead of bypassing role checks.

Messages now fetch a missing guild member before deciding whether a user can start or continue sessions, autocomplete no longer exposes project metadata to unauthorized users, and live voice audio is ignored unless the speaker has normal Kimaki access.
