---
'kimaki': patch
---

**Agents keep going on their own when they wait for a user action.** When an agent needs the user to do something outside the chat, like accepting a sudo or permission dialog or logging in, it now asks, runs `kimaki sleep --duration 5m`, and checks again when it wakes. If you do the action and forget to send a message, the session still continues. You can still reply while it sleeps; your message wakes it right away.
