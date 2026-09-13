---
'kimaki': patch
---

Allow reads outside the project by default on OpenCode v2.

Kimaki's v2 server config already allowed `read`, `edit`, and `shell`. It did not allow `external_directory`, so ordinary reads outside the project opened a permission prompt. The default is still allow-all unless you start with `--restrict-directories`.
