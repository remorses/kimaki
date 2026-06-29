---
"kimaki": minor
---

Run the slash command referenced by a question option when it is clicked. Selecting an `AskUserQuestion` option whose label or description points at a registered command (for example Prometheus' "Start Work" option, described as "Execute now with `/start-work`") now executes that command — switching agent exactly like typing it does — instead of sending the option label back to the current agent, which could not switch agents or run commands.
