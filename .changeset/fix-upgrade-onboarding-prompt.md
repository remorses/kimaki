---
'kimaki': patch
---

Fix the unexpected “Which server should Kimaki use?” prompt after the bot is already running.

Check whether onboarding is needed before selecting a server. Existing project mappings, including those imported from V1, count as a configured install even when V2's new default project folder has no mapping. Fresh installs still select a server, and an unfinished onboarding still retries its empty default channel.
