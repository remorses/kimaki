---
'kimaki': patch
---

Filter false-positive "duplicate skill name" warnings from OpenCode stderr.

When OpenCode discovers skills through multiple scan paths, it may log a
"duplicate skill name" warning where `existing` and `duplicate` point to the
same file. These warnings were logged at `error` level in Kimaki, creating
noise in kimaki.log. The stderr handler now detects and suppresses these
false-positive warnings; genuinely different files with the same name are
still reported as warnings.

Fixes #121
