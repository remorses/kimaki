---
'kimaki': minor
---

Show an estimated input-context breakdown below `/context-usage`. The new line shows the share and token count for visible system instructions, tool calls and results grouped by tool type, and other context (messages, hidden instructions, and provider overhead).

For example: `tool read 42.0% (21) · system 20.0% (10) · other 38.0% (19)`. Percentages use the provider's most recent reported input, including cached input. The breakdown is an estimate because OpenCode does not expose exact per-part token counts.
