---
'kimaki': minor
'website': patch
---

Add **coordinator** mode for project channels. A coordinator channel is a chat with one long session: you write in the channel, it answers in the channel, and it starts a thread for each piece of work.

It is off by default. Turn it on for one channel with `/toggle-coordinator`, or for every channel without its own choice with the start flag:

```bash
kimaki --enable-coordinator
```

```
#my-app
  you: fix the flaky login test
  (thread "Fix flaky login test" starts)
  Fixed in #fix-flaky-login-test: the test now awaits the session cookie.
```

- The coordinator starts workers in the background and says nothing about it: you already see the new thread start. A btw fork it starts is silent too. A follow-up it queues for a busy worker gets one short line with that thread's link, because no new thread shows in the channel and the prompt waits behind the current run. It speaks before a run ends only when you need it now: an answer to your question, a decision or a blocker. When a run the coordinator prompted ends (a worker it started, a follow-up or a fork it sent), its final answer wakes the coordinator, which reports the outcome with one link to the thread. Kimaki posts no other finish notice.
- For related work that needs the same context, the coordinator can fork a worker or a past session with `kimaki send --thread <id> --prompt '... btw' --parent-session <coordinator>`, when the fork touches different files. `--parent-session` now also applies to btw forks, and the fork wakes the coordinator when it ends, like any worker.
- Before it reports, the coordinator reviews the real change: it reads each critique diff as a patch (`<critique url>.patch`) and the changed files when needed.
- The coordinator report of a worker includes its critique diff URLs (one per commit) and the thread link, which points to any files the worker uploaded. When a worker reports changes or commit hashes without diff URLs, the coordinator makes them itself. `kimaki upload-to-discord` now prints the Discord URL of each uploaded file (`{"uploaded":[{"name","url"}]}`), and `kimaki session read`, `--full` and the session transcripts list the media each run uploaded.
- Worker threads do not join your sidebar unless you ask to follow one, or the work is planning or long work you will probably take part in. You can still open and steer any worker thread.
- When you write in a worker thread yourself, the run does not wake the coordinator: you already see the answer in that thread. The coordinator gets a silent note with your prompt and reads it at your next message, so it knows what you asked.
- With `kimaki send --wait` the sender gets the answer in the command output instead: a run whose prompt came from `--wait` sends no note while its sender still runs, so the result is never reported twice. Other threads of the channel and routines leave a silent note for the next prompt.
- The coordinator reads files and the repo source itself to understand the project, and delegates edits, builds, tests, long debugging and big research, so its context stays clean across many compactions. It writes short worker prompts as bullet lists without headings, in the style of its replies. Every worker is a visible thread you can talk to. The coordinator uses the `subagent` tool only for quick throwaway lookups.
- Workers read the coordinator session for project context. The coordinator keeps memory in a tracked `MEMORY.md`, read through its headings.
- The coordinator keeps its own prompt cache warm while it or a thread of its channel runs, for at most 1.5 hours after its last turn, so a finished worker wakes it with a cache read instead of a full cache write. It uses OpenCode-style keep-alive requests and does not need the global `warming` config. When the channel goes idle, the coordinator is compacted while its cache is still warm, once its context passes 100k tokens (also with 1M-context models). The warmup survives an OpenCode plugin reload, for example after a Kimaki upgrade.
- The coordinator and worker instructions come from the Kimaki OpenCode plugin. After a Kimaki upgrade, an existing coordinator or worker gets the new instructions at its next message, added after the history, so the prompt cache stays warm.
- A coordinator turn with nothing for you (a started worker, notes of threads you already see) posts nothing: the coordinator answers `IDLE`, which Kimaki hides with no footer, instead of filler like "nothing new".
- The first answer text to each of your messages (text, voice or queued) is a Discord reply to that message, so you can see where each answer starts when you open the channel from a notification. Tool lines, wake answers and worker threads never reply, and the reply does not ping you.
- `/toggle-coordinator` turns coordinator mode on or off for the channel. The choice is saved and wins over `--enable-coordinator`. Turning it off keeps the coordinator session, so turning it on again continues it.
- `/reset-coordinator` resets the channel context: the next message starts a fresh coordinator. The old session stays in OpenCode.
- With coordinator mode on, onboarding answers in the `#kimaki` channel instead of a thread.
- `kimaki session read <id>` now prints only prompts and final answers. Use `--full` for every tool call. `kimaki session wait` and `kimaki send --wait` print the same short output.
