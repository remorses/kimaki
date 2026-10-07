---
'kimaki': patch
---

Fix repeated command-discovery errors from saved project paths that no longer exist or point to files. Skip those paths and read each project once per registration pass, even when it belongs to multiple Discord guilds. Failures from valid project folders now include the project path and underlying OpenCode error.

Keep the full project catalog accessible when Discord's 100-command limit leaves no room for every shortcut:

- `/skill name:` autocompletes and runs any skill in the current project.
- `/command name:` autocompletes and runs any OpenCode command in the current project, including MCP prompts.
- Existing agent, command, and skill shortcuts remain available within Discord's limit.
