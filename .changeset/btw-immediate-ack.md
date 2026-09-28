---
'kimaki': patch
---

Show an immediate reply when a message ends with `. btw`. Kimaki now answers right away with a subtext line while it forks the session and creates the side thread:

```
-# Forking session to answer this side question...
```

When the fork is ready, the same message is edited to `Session forked! Continue in #thread`, or to the error text if the fork fails. Before, nothing appeared in the source thread until the whole fork setup finished, which could take more than 10 seconds.

Kimaki also logs Discord REST rate limits and per-step btw fork timings (`[BTW TIMING]`) to `kimaki.log`, so slow forks can be explained.
