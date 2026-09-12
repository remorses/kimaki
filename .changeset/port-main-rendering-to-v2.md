---
'kimaki': patch
---

Preserve live Discord tool output when using OpenCode V2. Render completed text and tool activity before the turn ends, flush remaining output before the footer, and do not repeat successful tool lines at completion. Failed tools still show their errors.

Use native session rename events to update Discord thread titles while keeping worktree and side-session prefixes. Preserve quoted banners and footers, blank-line text/tool spacing, and pending-question output ordering.

Restore context-usage notices during multi-step V2 runs using native step and token events rather than legacy message updates.

Related to #220 and #208.
