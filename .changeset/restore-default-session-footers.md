---
'kimaki': patch
'website': patch
---

Restore session footers after every completed assistant turn.

Completed turns again post the metadata line (`folder ⋅ branch ⋅ duration ⋅ context% ⋅ model`). The final footer mentions the thread creator so Discord notifies when work is done. Intermediate footers stay silent while the queue still has work.

`--session-footers` is removed. Use `--skip-footer-mentions` if you want the footer without pinging the thread creator.
