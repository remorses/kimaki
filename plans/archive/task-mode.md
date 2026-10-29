Status: superseded by the coordinator implementation (plans/decisions/coordinator.md). Subagent threads were dropped for `kimaki send` threads.

# Task mode plan

A **task channel** is a project channel where the user chats with one infinite
orchestrator session directly in the channel, with no thread. The orchestrator delegates
all work to background subagents. Each subagent gets its own Discord thread, and the user
can talk to it there. The root session stays warm for 1 hour after the last prompt, then
compacts while the user is away.

```
#kimakivoice (task channel)                       threads
  Tommy: fix the flaky login test
  -# ┣ subagent opus **fix flaky login test**
  Kimaki started a thread: fix flaky login test ───▶ » user: You are a subagent ...
  On it, see <#thread>.                               -# ┣ shell _pnpm test login_
  -# *kimakivoice ⋅ main ⋅ 12s ⋅ 4% ⋅ opus*           The test raced the cookie. Fixed.
  ⬦ opus finished: fix flaky login test <#thread>     -# *kimakivoice ⋅ main ⋅ 3m ⋅ 31% ⋅ opus*
  Fixed in <#thread>: login test awaited the cookie.
```

Done check: in a real task channel, one prompt produces a reply in the channel, a child
thread with the subagent's work, a finished line, warm requests every 4 min for 1 hour,
then one compaction. Task order: 0 (spikes), 1, 2, 3, 4, 5, 6, 7, 8.

## How to read this

One box is one unit of work. Check a box only when its evidence exists: a command output,
a file, a screenshot, a log line, a commit SHA. Write the evidence next to the box.
Tests alone are not verification. Each task is verified on the real artifact.

## Research summary (OpenCode v2 2.0.26, read 2026-10-24)

| Need | OpenCode today | Source |
| --- | --- | --- |
| background subagents | `subagent` tool, `background: true`, completion arrives as a synthetic `<subagent sessionID state>` item in the parent | `core/src/tool/plugin/subagent.ts`, `session/subagent-completion.ts` |
| child model choice | `agent` + optional `model` input; agents with `mode: subagent` or `all` | same |
| child placement | **none**. A child always inherits the parent location, metadata and permissions. `Location.workspaceID` is "reserved for future placement semantics" | `core/src/session.ts:262`, opencode `AGENTS.md` |
| nested subagents | `experimental.subagent_depth`, default 1 | `subagent.ts` |
| warming | global config only (`warming: { interval, duration }`), default 4 min / 30 min. Per session is open issue [#58163](https://github.com/anomalyco/opencode/issues/58163) | `core/src/plugin/warming.ts` |
| warm request from a plugin | `ctx.session.generate({ sessionID, prompt })`: same context, no history change | `plugin/src/promise/session.ts` |
| compaction | `session.compact` inbox item; runs at the next safe point and blocks prompts behind it. No real background compaction | `docs/compaction.mdx`, `session/compaction.ts` |
| precomputed summary | `compaction` hook can set `event.result` and skip the model call | `plugin/src/promise/session.ts` `SessionCompaction` |
| instructions | children do not inherit instruction entries. A later `entry.put` reaches the model as an appended system message (no cache break) | `instruction-state.ts` |

Recorded order of a subagent call (`docs/opencode-v2-events/task-subagent.events.jsonl`):

```
parent tool.called ─▶ child session.created (title = description) ─▶ parent tool.progress { sessionID }
  ─▶ child inbox.enqueued ─▶ child execution.started ─▶ child instructions.updated ─▶ child steps ...
```

<details>
<summary>Cross-machine subagents: answer</summary>

The `subagent` tool cannot run a child on another computer or another directory. No open
OpenCode issue asks for it. Closed as stale: [#29271](https://github.com/anomalyco/opencode/issues/29271)
(directory param for subagents), [#34216](https://github.com/anomalyco/opencode/issues/34216)
and [#34872](https://github.com/anomalyco/opencode/issues/34872) (worktree isolation).

Proposal: open one issue, "subagent: optional placement (directory or workspace) for child
sessions", once workspaces ship placement. Until then Task 8 covers other machines with
`kimaki send --channel <other machine channel>` plus a completion relay.
</details>

## Design

### Data shape

```
SQLite task_channels(channel_id PK -> channel_directories, session_id, created_at)   new table
roots[channelId]        = root session      same map as threads; a conversation id is a channel or thread id
sessionThreads[childId] = child thread      child threads are normal thread_sessions rows
view.channelId === conversation id         ⇒ task root view (derived, no new flag)
marker (root)  kimaki: { mode: 'task', threadId: channelId, warming: { intervalMs, durationMs } }
marker (child) kimaki: { mode: 'task-child', threadId: <child thread>, parentThreadId: channelId }
```

No new store fields. Task mode is a fact of SQLite and of the session marker.

### Flow

```
channel msg ─▶ ingress ─▶ roots[channelId]? steer (interrupt + prompt) : startTaskSession
root tool.called subagent ─▶ tool line in channel
child session.created(parent = task root) ─▶ event loop holds child events
   ─▶ bindChildThread: channel.threads.create(title) ─▶ thread_sessions row ─▶ child marker
      ─▶ child instructions entry ─▶ eventLoop.bind(child thread) ─▶ release held events
      ─▶ parent: kimaki.child-thread event (pure view) + synthetic note with the thread URL (resume: false)
child events ─▶ child thread view (text, tools, footer: same reducer as any root)
parent inbox synthetic { source: 'subagent', childID } ─▶ "⬦ opus finished: … <#thread>"
user msg in child thread ─▶ steer WITHOUT interrupt (keeps the subagent job alive, Task 0 S3)
```

### Prompt and context window

- Keep the base Kimaki prompt as is. Add one tagged section `task-mode` only for task roots,
  and one short section `task-child` only for child threads. Both are static, so the
  cached prefix never changes. Do not edit the shared sections other sessions use.
- The biggest context cost of an orchestrator is what flows back into it: tool outputs it
  reads and subagent final messages. The child section asks for a final message of at
  most ~15 lines, long details written to a file with its path (Cursor "Files and handoff").
- The root section (Cursor coordinator ideas): send a short ack first, then launch;
  delegate all reading, editing and testing; background by default; parallel only when
  write scopes do not overlap; continue an existing child with `sessionID` instead of
  re-explaining; pick the agent by task difficulty; link children as `<#threadId>`; never
  say a child still works without checking (`kimaki session read`); do not repeat
  confirmations on every notification; read transcripts of this and other projects
  (`<dataDir>/transcripts`, `kimaki session read`) to learn what happened or debug.

### Cache rules (from the attached slide, mapped to Kimaki)

| Rule | Kimaki |
| --- | --- |
| system prompt, tools, first message stay the same until the next summary | instruction entry frozen at create; plugin tool extras are constant; background default changes the tool **input** in `execute.before`, never the schema |
| changed tool text becomes a note | OpenCode instruction epochs already do this |
| fixed order, sorted | subagent list is sorted by OpenCode; plugin pushes in fixed order |
| tools never added or removed per turn | no per-turn permission or tool changes in task roots |
| hash each section | cache-miss line exists (`formatCacheMiss`). Optional later: log a hash per prompt part |
| warm when the user opens chat or types | Task 6: Discord `TYPING_START` in a task channel triggers one warm request |

## Task 0: spikes (riskiest unknowns)

**Depends on.** None.

**Files.**
- [ ] Scratch only: `tmp/task-mode-spike/` (gitignored), throwaway test files.

**Build.**
- [ ] S1: bind a root session to a **channel** ID in a throwaway e2e test (digital twin). Check `effects.ts` send, typing, footer and `event-loop.ts` `loadView` (it assumes `thread.isThread()`).
- [ ] S2: background `subagent` with the deterministic provider: record events, confirm the order above holds for `background: true` and the parent gets the synthetic `<subagent>` item.
- [ ] S3: while a background child runs, `session.prompt({ delivery: 'steer' })` to the child **without** interrupt. Check the parent notification carries the final text after the user message. Then prompt an idle child: confirm the parent gets **no** notification (Task 5 relays it).
- [ ] S4: from the kimaki plugin, `ctx.session.generate` on a root session, then `ctx.session.compact`. Check `cache.read` of the compaction step matches the warm prefix (Anthropic, real model, one run).

**You see.**
- [ ] A short table per spike in Appendix A: what happened, with the event log path.

**Verify.**
- [ ] Each spike result is written in Appendix A with a jsonl path under `tmp/task-mode-spike/`.

**Progress.**

## Task 1: task channels in SQLite and `/task-mode`

**Depends on.** Task 0 S1.

**Files.**
- [ ] Edit `kimaki/src/schema.ts` (table `task_channels`), run `pnpm generate` for `schema-sql.ts`
- [ ] Edit `kimaki/src/commands/preference-commands.ts` (`/task-mode enable|disable`)
- [ ] Edit `kimaki/src/slash-commands.ts` (register)
- [ ] Edit `kimaki/src/event-loop.ts` `load()` (roots from `task_channels` too)
- [ ] Edit `kimaki/src/db.test.ts` (old database opens with the new table)

**Build.**
- [ ] `/task-mode enable` inserts the row; the root session is created on the first message. `disable` deletes the row and unbinds the channel; the session stays in OpenCode.

**You see.**
- [ ] `/task-mode enable` replies `Task mode on. Messages here go to one long session; work runs in threads.`

**Verify.**
- [ ] `pnpm run test --run src/db.test.ts` passes.
- [ ] `pnpm build` passes.

**Progress.**

## Task 2: root session in the channel

**Depends on.** Task 1.

**Files.**
- [ ] Edit `kimaki/src/ingress.ts` (channel message in a task channel)
- [ ] Edit `kimaki/src/sessions.ts` (`startTaskSession`)
- [ ] Edit `kimaki/src/prompt.ts` (`dispatch` takes a conversation: `ThreadChannel | TextChannel`)
- [ ] Edit `kimaki/src/interaction-context.ts` (`resolveTarget` returns the channel root in a task channel, so `/abort`, `/model`, `/compact`, `/queue` work there)
- [ ] Edit `kimaki/src/event-loop.ts` `loadView` (channel case)
- [ ] Add `kimaki/src/task-mode.e2e.test.ts`

**Build.**
- [ ] First message creates the session with marker `mode: 'task'`, `threadId: channelId`, and binds roots[channelId]. Later messages steer it. `. queue` queues; `. btw` forks the root into a `btw:` thread; `/new-session` still makes a normal thread.

**You see.**
- [ ] Banner, reply and footer appear in the channel, no thread is created.

**Verify.**
- [ ] `pnpm run test --run src/task-mode.e2e.test.ts` passes; its `channel(id).text()` inline snapshot shows banner, reply, footer.
- [ ] Real Discord: enable on a test channel, send `hi`, see the reply in the channel.

**Progress.**

## Task 3: `task-mode` and `task-child` prompt sections

**Depends on.** Task 2.

**Files.**
- [ ] Edit `kimaki/src/system-prompt.ts` (two sections, gated by mode)
- [ ] Edit `kimaki/src/builtin-skills.ts` (`PROMPT_SECTIONS`: `task-mode`, `task-child`)
- [ ] Edit `kimaki/src/sessions.ts` `putInstructions` (mode param)

**Build.**
- [ ] Root section per Design. Child section: you run in your own Discord thread, the user may write to you there; final message at most ~15 lines, details in a file with its absolute path; report files, branches, PRs.

**You see.**
- [ ] `kimaki session read <root>` shows the task section once, in the first system prompt.

**Verify.**
- [ ] Snapshot test of `baseInstructions({ mode: 'task' })` in an existing system prompt test, reviewed in the diff.

**Progress.**

## Task 4: child sessions get their own threads

**Depends on.** Task 0 S2, Task 3.

**Files.**
- [ ] Edit `kimaki/src/event-loop.ts` (hold child events of a task root; new injected callback `onTaskChild`, like `onRunEnded`)
- [ ] Edit `kimaki/src/sessions.ts` (`bindChildThread`)
- [ ] Edit `kimaki/src/thread-reducer.ts` (`kimaki.child-thread` event, finished line from the parent synthetic item)
- [ ] Edit `kimaki/src/main.ts` (wire the callback)
- [ ] Edit `kimaki/src/plugin/index.ts` (`execute.before`: `subagent` in a task root gets `background: true` unless set)
- [ ] Edit `kimaki/src/thread-reducer.test.ts` (fixture test for the parent lines)
- [ ] Edit `kimaki/src/task-mode.e2e.test.ts`

**Build.**
- [ ] `bindChildThread`: `channel.threads.create({ name: title })` (Discord posts "started a thread" in the channel), add the user, insert `thread_sessions`, update child marker, put child instructions, `eventLoop.bind`, release held events in order, dispatch `kimaki.child-thread` to the parent, send the parent a synthetic `<thread session="ses_x" url="…"/>` with `resume: false`.
- [ ] After a bot restart, an unknown child whose ancestor is a task root takes the same path (`resolveUnknownSession`).

**You see.**
- [ ] Channel: tool line, "started a thread", reply, footer, later `⬦ opus finished: … <#thread>`.
- [ ] Thread: `» user:` task prompt, child tool lines and text, child footer.

**Verify.**
- [ ] e2e snapshots of `channel(id).text()` and `thread(child).text()` match the lines above.
- [ ] `pnpm run test --run -u` full suite; review snapshot diff.

**Progress.**

## Task 5: user messages in child threads

**Depends on.** Task 4, Task 0 S3.

**Files.**
- [ ] Edit `kimaki/src/prompt.ts` (child thread: steer without interrupt while the job runs)
- [ ] Edit `kimaki/src/event-loop.ts` or `sessions.ts` (relay: a child execution that ran after its job ended sends the parent a synthetic `<subagent sessionID state="completed">` with the last text, `resume: true`)

**Build.**
- [ ] Exact behavior follows S3. `/abort` in a child thread still interrupts.

**You see.**
- [ ] User writes in the child thread, the child answers there, the channel gets a finished line, and the root reacts.

**Verify.**
- [ ] e2e case in `task-mode.e2e.test.ts` with inline snapshots of both conversations.

**Progress.**

## Task 6: 1 hour warming, typing warm-up

**Depends on.** Task 0 S4, Task 2.

**Files.**
- [ ] Edit `kimaki/src/plugin/index.ts` (warming loop for marked task roots; settings from the marker)
- [ ] Edit `kimaki/src/ingress.ts` (`TypingStart` in a task channel posts one warm request through the lock-port API or `client.session.generate`)
- [ ] Edit `kimaki/src/main.ts` (Discord intent `GuildMessageTyping` if missing)

**Build.**
- [ ] Same rules as OpenCode `WarmingPlugin`: every non-warm request resets the window; warm after 4 min idle; stop after 1 hour. Skip when the global `warming` config is on (no double warming).
- [ ] `// TODO: use per-session OpenCode warming once it exists. https://github.com/anomalyco/opencode/issues/58163`

**You see.**
- [ ] `kimaki logs` shows `warming task session ses_x` every ~4 min, stopping after 1 hour.

**Verify.**
- [ ] e2e with marker warming `{ intervalMs: 300, durationMs: 1000 }`: the deterministic provider sees 2 or 3 `generate` requests, then none.
- [ ] Real run: `cache.read` of the next real step after 30 min idle is close to the previous prefix (no `prompt cache miss` line).

**Progress.**

## Task 7: idle compaction at the end of the warm hour

**Depends on.** Task 6.

**Files.**
- [ ] Edit `kimaki/src/plugin/index.ts`

**Build.**
- [ ] When the warm window ends and the root and its children are idle, call `ctx.session.compact` while the cache is still warm. Skip when the last step used less than 25% of the context window.
- [ ] Compaction keeps child thread links: the root section asks the agent to keep a short list of open threads and their state in its messages, so the summary carries them (S4 checks this).

**You see.**
- [ ] Channel: `⬦ context compacted`, no footer, no ping.

**Verify.**
- [ ] e2e with short warming values: one `session.compaction.ended` after the window.
- [ ] Real run: the compaction step `cache.read` is near the warm prefix.

**Progress.**

## Task 8: subagents on other machines (later)

**Depends on.** Task 5.

**Files.**
- [ ] Edit `kimaki/src/system-prompt.ts` (`task-mode` section: use `kimaki send --channel <other machine channel> --parent-session` for work on other machines)
- [ ] Edit `kimaki/src/remote-send.ts`, `kimaki/src/ingress.ts` (completion relay envelope back to the parent channel's machine)

**Build.**
- [ ] When a session started by a remote send with a task-root parent finishes, its bot posts a relay envelope in the parent's task channel. The owner bot turns it into a synthetic `<subagent>` item for the root.

**You see.**
- [ ] A thread on machine B finishes; the task channel on machine A gets a finished line and the root reacts.

**Verify.**
- [ ] `remote-send.e2e.test.ts` case with two bots in one twin.

**Progress.**

## Done

- [ ] Every box above is checked with evidence.
- [ ] Real Discord task channel run as described at the top, plus `.changeset/task-mode.md`, a docs page in `website/src/docs/docs/`, and the architecture note in `AGENTS.md`.

## Appendix A. Prototype evidence

Settled by reading recorded events: child `session.created` carries `title` (the subagent
description) and arrives before any child event, right after the parent `tool.called`
(`docs/opencode-v2-events/task-subagent.events.jsonl`). S1 to S4 are open.

## Appendix B. Decisions

- `plans/decisions/task-mode.md`

## Appendix C. Risks

| Risk | Task | Watch |
| --- | --- | --- |
| child's first step runs before its instruction entry exists | 4 | the entry arrives as an appended system message; the first step lacks thread rules |
| interrupting a background child ends its job, the parent gets a stale or "cancelled" result | 5 | S3 decides steer-without-interrupt |
| warming costs: ~15 warm requests per idle hour, billed as cache reads | 6 | only task roots, only 1 hour |
| compaction is lossy for an infinite session | 7 | child threads and transcripts keep full history; the summary must list open threads |
| `resolveTarget` and `dispatch` assume threads in many commands | 2 | run the full e2e suite |
| children inherit session permissions, so the root cannot deny edits at session level | 3 | steer by prompt; an orchestrator agent with its own permissions is a later option |
