---
'kimaki': patch
---

**Agents no longer lose their answer when a turn ends with `kimaki sleep` or `kimaki buttons`.** The instructions asked for all text first and these commands last. Some models planned that text only in their hidden reasoning and then called the command, so the answer never reached Discord, and the sleep result then asked for just one short waiting line. Agents now run `kimaki sleep` first and write their answer right after it. Buttons have no fixed order anymore: the turn only has to explain them in text. The results of both commands ask for the full answer when the turn has none yet, so sessions started before this update get the fix too. `kimaki upload-request` keeps text first, because it waits for the upload.

Fixes #256
