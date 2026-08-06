---
'kimaki': minor
---

Add a `parallel-security-review` bundled skill for DeepSec-inspired security reviews.

The skill guides agents through a higher-signal review flow: derive compact repository security context, split candidate discovery across focused subagents, apply technology-specific false-positive rules, then validate each candidate independently before reporting only findings with confidence 8/10 or higher.

This gives users a more scalable security review option for larger PRs without replacing the existing focused `security-review` skill.
