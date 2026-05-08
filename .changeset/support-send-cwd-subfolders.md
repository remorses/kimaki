---
'kimaki': minor
---

Add support for starting `kimaki send --cwd` sessions inside project subfolders.

Scheduled and immediate sends can now use an existing directory under the channel project as the OpenCode working directory. This lets you keep a restricted `opencode.json` in a subfolder and run recurring tasks there so OpenCode loads that subfolder config.

```bash
kimaki send --project /repo --cwd /repo/restricted-task --send-at '0 9 * * 1' --prompt 'Run the restricted task'
```

Passing the project root to `--cwd` is also supported and behaves like the default project-root session.
