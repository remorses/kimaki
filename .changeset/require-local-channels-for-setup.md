---
'kimaki': patch
---

Require every Discord command, including `/add-project` and `/create-new-project`, to run in a channel connected to the local machine, or a thread under that channel. Setup commands no longer bypass channel ownership checks.

In self-hosted mode, startup only creates a default Kimaki channel in servers that already contain a locally connected channel. Joining a new server no longer automatically connects it to the machine. Configure the first project through the local CLI, then use Discord setup commands from that project channel. Gateway-mode default channel setup is unchanged.

Existing channel mappings remain configured. Remove the bot from any untrusted servers where it was previously installed, and disable Public Bot in the Discord Developer Portal for self-hosted bots.
