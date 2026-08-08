---
'kimaki': patch
---

Allow `/create-new-project` to run from inside a thread, not only from a text channel.

Before, running the command in a thread replied with `This command can only be used in a text channel`, so you had to leave the thread, scroll back to the parent channel, and run it there. The current channel was never actually used by the command; it only guarded the entrypoint.

Now the command works from both places:

```
/create-new-project name: my-new-app
```

It still creates a dedicated text channel (and voice channel) for the new project, initializes the folder with `git init`, and starts a session in a fresh thread there. So you can spin up a new project without interrupting the thread you are currently working in.
