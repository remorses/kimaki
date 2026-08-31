---
'kimaki': patch
---

Prevent a pending question from reappearing after the user has already started a newer turn.

If Kimaki restarts while a question tool is waiting, the persisted event stream can contain `question.asked` without `question.replied`. A later user message now makes that old question inactive, so its dropdown and preceding text cannot appear during the new response.
