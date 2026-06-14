---
'kimaki': minor
---

Surface questions from sub-agent sessions in the Discord thread.

When a sub-agent (e.g. an `explore` or `general` agent) calls the `question`
tool, the question now appears in the parent Discord thread with a
`[agentType-index]` label instead of being silently ignored. Answers submitted
via the Discord dropdown are routed back to the correct sub-agent session.
