---
'kimaki': minor
'website': patch
---

Turn session footers off by default. Finished turns now ping you in the last assistant line instead of a metadata footer.

The ping uses your Discord user ID plus a short summary, for example `<@535922349652836367> tests passed`. That creates the sidebar red dot for completed sessions and puts a useful line in the notification.

The old footer (`folder ⋅ branch ⋅ duration ⋅ context% ⋅ model`) is opt-in:

```bash
kimaki --session-footers
```

`--skip-footer-mentions` is removed. When footers are on, they are metadata only and no longer mention the thread creator.
