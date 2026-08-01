---
'kimaki': patch
---

Free Discord slash-command slots by moving secondary actions onto parent messages.

**Removed slash commands** (use the replacement instead):

| Removed | Replacement |
|---|---|
| `/screenshare-stop` | **Stop screen share** button on `/screenshare` reply |
| `/model-variant` | **Change thinking level** button on `/model` |
| `/unset-model-override` | **Clear session/channel override** button on `/model` |
| `/toggle-worktrees` | **Turn on/off** auto-worktrees control in `/worktrees` |
| `/clear-queue` | **Remove from queue** button on each `/queue` confirmation |

`/vscode` also gained a **Stop VS Code** button (there was never a stop slash command).

When Discord's 100-command limit is hit, registration priority is now:

```
built-ins → agents (*-agent) → user commands → MCP prompts → skills (trimmed first)
```
