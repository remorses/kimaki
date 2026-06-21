---
'kimaki': patch
---

Fix multi-question Discord dropdowns so duplicate select interactions cannot submit incomplete answers.

Kimaki now derives question completion from the actual answered question indexes instead of incrementing a counter. This prevents a repeated click on one dropdown from making OpenCode receive empty answers for later questions, which could make the model ask for the missing answers again.
