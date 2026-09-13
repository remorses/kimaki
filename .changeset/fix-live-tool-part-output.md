---
'kimaki': patch
---

Show tool calls in Discord while a turn is still running.

The recent quote-hold path kept the latest text **and every tool after it** until a later text part arrived. Turns that only had one text part never flushed those tools until the very end, so live tool lines disappeared. Progress flushes now send completed text and the tools that follow it.
