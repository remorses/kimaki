---
'kimaki': minor
'website': patch
---

Add **mainmast** channels, the new default. A project channel is now a chat with one long session: you write in the channel, it answers in the channel, and it starts a thread for each piece of work.

```
#my-app
  you: fix the flaky login test
  (thread "Fix flaky login test" starts)
  Fixed in #fix-flaky-login-test: the test now awaits the session cookie.
```

- The mainmast starts workers in the background and says nothing about it: you already see the new thread start. A btw fork it starts is silent too. A follow-up it queues for a busy worker gets one short line with that thread's link, because no new thread shows in the channel and the prompt waits behind the current run. It speaks before a run ends only when you need it now: an answer to your question, a decision or a blocker. When a run the mainmast prompted ends (a worker it started, a follow-up or a fork it sent), its final answer wakes the mainmast, which reports the outcome with one link to the thread. Kimaki posts no other finish notice.
- For related work that needs the same context, the mainmast can fork a worker or a past session with `kimaki send --thread <id> --prompt '... btw' --parent-session <mainmast>`, when the fork touches different files. `--parent-session` now also applies to btw forks, and the fork wakes the mainmast when it ends, like any worker.
- Before it reports, the mainmast reviews the real change: it reads each critique diff as a patch (`<critique url>.patch`) and the changed files when needed.
- The mainmast report of a worker includes its critique diff URLs (one per commit) and the thread link, which points to any files the worker uploaded. When a worker reports changes or commit hashes without diff URLs, the mainmast makes them itself. `kimaki upload-to-discord` now prints the Discord URL of each uploaded file (`{"uploaded":[{"name","url"}]}`), and `kimaki session read`, `--full` and the session transcripts list the media each run uploaded.
- Worker threads do not join your sidebar unless you ask to follow one, or the work is planning or long work you will probably take part in. You can still open and steer any worker thread.
- When you write in a worker thread yourself, the run does not wake the mainmast: you already see the answer in that thread. The mainmast gets a silent note with your prompt and reads it at your next message, so it knows what you asked.
- With `kimaki send --wait` the sender gets the answer in the command output instead: a run whose prompt came from `--wait` sends no note while its sender still runs, so the result is never reported twice. Other threads of the channel and routines leave a silent note for the next prompt.
- The mainmast reads files and the repo source itself to understand the project, and delegates edits, builds, tests, long debugging and big research, so its context stays clean across many compactions. It writes short worker prompts as bullet lists without headings, in the style of its replies. Every worker is a visible thread you can talk to. The mainmast uses the `subagent` tool only for quick throwaway lookups.
- Workers read the mainmast session for project context. The mainmast keeps memory in a tracked `MEMORY.md`, read through its headings.
- The mainmast keeps its own prompt cache warm while it or a thread of its channel runs, for at most 1.5 hours after its last turn, so a finished worker wakes it with a cache read instead of a full cache write. It uses OpenCode-style keep-alive requests and does not need the global `warming` config. When the channel goes idle, the mainmast is compacted while its cache is still warm, once its context passes 100k tokens (also with 1M-context models). The warmup survives an OpenCode plugin reload, for example after a Kimaki upgrade.
- The mainmast and worker instructions come from the Kimaki OpenCode plugin. After a Kimaki upgrade, an existing mainmast or worker gets the new instructions at its next message, added after the history, so the prompt cache stays warm.
- A mainmast turn with nothing for you (a started worker, notes of threads you already see) posts nothing: the mainmast answers `IDLE`, which Kimaki hides with no footer, instead of filler like "nothing new".
- The first answer text to each of your messages (text, voice or queued) is a Discord reply to that message, so you can see where each answer starts when you open the channel from a notification. Tool lines, wake answers and worker threads never reply, and the reply does not ping you.
- `/new-mainmast` starts a fresh mainmast in the channel.
- Onboarding answers in the `#kimaki` channel instead of a thread.
- `kimaki session read <id>` now prints only prompts and final answers. Use `--full` for every tool call. `kimaki session wait` and `kimaki send --wait` print the same short output.

Start Kimaki with `--no-mainmast` to keep one new thread per channel message.
