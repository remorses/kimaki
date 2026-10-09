---
'kimaki': patch
---

Drain the local Discord queue after an OpenCode v2 interrupt.

v2 emits `session.execution.interrupted` instead of always following with `session.idle`. Messages sent during abort (or right after `/abort`) now start once that interrupt lands, instead of sitting in the queue with no reply.
