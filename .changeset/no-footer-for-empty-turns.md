---
'kimaki': patch
---

Skip the footer after a turn that posted nothing visible. When the agent writes no text and its tool lines are all hidden (read-only tools at the default verbosity), Discord no longer shows a footer for that turn. Two footers in a row, for example after a woken coordinator answered with nothing, are gone.

```
-# *kimakivoice ⋅ main ⋅ 15s ⋅ 17% ⋅ claude-opus-5-5 ⋅ opus*
-# *kimakivoice ⋅ main ⋅ 15s ⋅ 17% ⋅ claude-opus-5-5 ⋅ opus*   <- no longer posted
```

In a coordinator channel, a turn that posts no text (or only answers `IDLE`) also gets no footer, even when it shows tool lines. Starting a worker now shows only its `kimaki send` line in the channel, and the footer comes with the report when the worker ends.

```
you: fix the flaky login test
-# ┣ shell _Start the worker thread_
-# *kimakivoice ⋅ main ⋅ 8s ⋅ 12% ⋅ claude-opus-5-5*   <- no longer posted
```

The same rule applies to the silent footer between queued messages of one execution.
