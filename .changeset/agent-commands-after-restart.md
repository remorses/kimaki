---
'kimaki': patch
---

Fix `/<agent>-agent`, `/<command>-cmd` and `/<skill>-skill` slash commands missing from Discord after a restart, and the bot never finishing its startup when Discord rate limits command registration.

With OpenCode 2.2.7 and later, Kimaki read the agent, command and skill lists before OpenCode had loaded them, so the first registration on every start removed all of these commands and the next one created them again. A few restarts used up Discord's limit of 200 command creates per server per day. discord.js then retried the registration for hours, so routines and `kimaki sleep` wakes never started in that run.

Kimaki now waits until OpenCode has loaded its plugins before it reads the lists, so a restart does not change the commands. Registration no longer overwrites the whole command list: Kimaki compares the commands Discord has with the ones it wants and only creates, edits or deletes the ones that differ. A restart with unchanged agents, commands and skills sends no write to Discord, and a changed description edits the command in place without spending the daily create limit. When Discord rate limits the command creates anyway, Kimaki logs it, continues starting, and tries again 10 minutes later.

Kimaki now needs OpenCode 2.0.29 or later.
