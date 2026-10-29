---
'kimaki': patch
---

Agents reply in Discord more concisely and more naturally: they lead with the answer and write short, plain, complete sentences instead of terse fragments and "label: value" lines. Every Discord prompt carries a short reminder to think first and say it in the fewest words, the system prompt shows example replies, and failures and warnings still go in a callout.

Coordinator reminders and wake-ups stay silent unless something is important. On an idle reminder, a note from another thread, or the end of a worker it started on its own, the coordinator replies `IDLE` (hidden in Discord) unless the user should really see the result: a failure, a blocker, a decision only they can make, or work they asked for. It no longer posts status updates or recaps of what it is doing.

Worker prompts written by the coordinator quote the user's words verbatim instead of summarizing them, and say what the user wants and what done means, not how to do it. Recurring how-to like test commands and build steps belongs in AGENTS.md, so the coordinator suggests adding it there instead of repeating it in every prompt.
