---
'kimaki': patch
---

Clean up local state when Discord channels and threads are deleted.

Kimaki now removes stale project mappings, channel preferences, forum sync configuration, queued messages, pending interactions, sleeps, and scheduled deliveries that can no longer reach Discord. Active child runtimes are stopped even when Discord does not emit separate deletion events for each thread.

On startup, Kimaki also verifies saved channel mappings and removes entries that Discord confirms no longer exist. Temporary API failures preserve the mapping. The default Kimaki channel remains as an intentional tombstone so it is not recreated after deletion.
