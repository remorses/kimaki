---
'kimaki': minor
---

Replace `kimaki session search` with transcript files you search with `rg`.

Kimaki now writes one markdown file per session to `<data-dir>/transcripts/<session id>.md` when a run ends: user messages, assistant text and short tool inputs. No tool outputs, no thinking.

```bash
rg -il 'auth timeout' ~/.kimaki/transcripts          # sessions that mention it; the file name is the session ID
rg -i -C3 'auth timeout' ~/.kimaki/transcripts/ses_xxx.md
rg -iP 'error\s+42|panic' ~/.kimaki/transcripts      # regex
```

Sessions Kimaki did not run, and old sessions, are written by the new sync command. It skips current transcripts, so running it again is cheap:

```bash
kimaki session sync                # last 14 days
kimaki session sync --days 60
kimaki session sync --all          # every session, any age
kimaki session sync --rebuild      # write all again, for example after the format changed
```

The agent system prompt now shows these `rg` examples.
