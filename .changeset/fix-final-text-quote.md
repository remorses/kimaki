---
'kimaki': patch
---

Fix short final replies that stayed quoted in Discord after the assistant finished. One-line progress updates remain quoted while the run is active, then the final reply is edited back to full-width text. Multi-line replies stay full-width from the start.
