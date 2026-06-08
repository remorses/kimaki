---
'kimaki': patch
---

Filter disabled skills from Discord slash command registration.

`--disable-skill` and `--enable-skill` CLI flags now also prevent the
corresponding skill commands from being registered as Discord slash commands.
Previously these flags only injected `permission.skill` deny/allow rules into
the opencode config, but the skills still counted toward Discord's 100-command
limit. Now disabled skills are excluded from registration, freeing up slots for
commands the user actually wants.

Fixes #145
