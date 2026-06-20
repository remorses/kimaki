---
'kimaki': patch
---

Fix slash commands being handled by the wrong machine in multi-machine setups.

When kimaki is installed on multiple machines sharing the same Discord guild (via
gateway proxy), interactions (slash commands, buttons, select menus, modals) were
processed by every machine regardless of channel ownership. Messages already had a
channel directory check that correctly ignored unconfigured channels, but interactions
skipped this check entirely.

Now the interaction handler checks if the channel (or parent channel for threads) has a
project directory configured in the local sqlite database before processing. If not, the
interaction is silently ignored so the correct machine handles it.
