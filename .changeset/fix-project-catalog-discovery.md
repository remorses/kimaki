---
'kimaki': patch
---

Fix missing agent and skill slash commands in Discord.

Shortcut commands (`/<agent>-agent`, `/<cmd>-cmd`, `/<skill>-skill`) now come from your **global** OpenCode catalog (`~/.config/opencode`, global skills, global plugins), the same list in every guild. Before, Kimaki merged the catalogs of every project in the guild: with many projects this went far past Discord's 100-command limit, cut most skills, and re-read every project on each catalog change.

```
agent|command|skill.updated ─▶ read global catalog ─▶ PUT guild commands (only if changed)
OpenCode reconnect          ─┘
```

- New global agents, commands and skills get their command as soon as OpenCode reports them, and again after an OpenCode restart.
- When more than 100 commands exist, the cut is stable: agents first, then commands, then skills, each sorted by name.
- Project-only entries and anything past the limit stay available through autocomplete:
  - `/agent` selects any agent of the current project.
  - `/skill name:` autocompletes and runs any skill in the current project.
  - `/command name:` autocompletes and runs any OpenCode command in the current project, including MCP prompts.
