---
title: Claude Projects and Claude Duet prompts vs the Kimaki coordinator
description: What is public about the system prompts of Anthropic's Claude Projects and Claude Duet, and which of their coordinator ideas Kimaki could adopt. Researched 2026-10-31.
---

# Claude Projects and Claude Duet prompts vs the Kimaki coordinator

**Claude Projects** (claude.ai/code, beta since 2026-09-17) has a leaked system prompt. **Claude Duet** (research preview since 2026-10-21) has none: no leak, no extract, only marketing pages.

| Product | Coordinator architecture | Prompt public? | Saved here |
| --- | --- | --- | --- |
| Claude Projects | yes: one coordinator conversation, one Thread Claude per thread | yes, the **Thread Claude** prompt, which also describes the coordinator role | `claude-projects-thread-system-prompt.md` |
| Claude Code coordinator mode, Projects fragments | yes: coordinator plus workers, relays, status cards | yes, extracted from the CLI bundle | `claude-code-coordinator-prompt-fragments.md` |
| Claude Duet | no, publicly it is one ongoing thread | no | nothing to save |

## Sources

- Claude Projects Thread Claude prompt, leaked 2026-09-20: https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-projects-thread-claude.md
- Claude Code prompt fragments (coordinator mode, Projects relays, status card classifier, proactivity): https://github.com/Piebald-AI/claude-code-system-prompts
- Official Projects docs: https://code.claude.com/docs/en/claude-projects
- Official Duet announcement: https://claude.com/resources/articles/claude-duet and product page https://claude.com/duet
- Ethan Mollick on the Projects coordinator: https://x.com/emollick/status/2112332499917681028
- "Claude Duet is a Claude Code session btw": https://x.com/FlippyMeister/status/2113733206050816125

The **Projects coordinator's own prompt** is not leaked as a separate file. The thread prompt is written in the third person on purpose so every Claude knows every role, so its "Claude in Projects" to "Relays from the coordinator session" sections are the coordinator protocol.

## Claude Duet: what is public

Searches on GitHub, X and Google found no Duet system prompt. Anthropic only says it ships a "dedicated classifier and safety system prompt" against leaks of credit card numbers and government IDs. Public behavior:

- a morning brief, then checks of connected apps every few hours, not continuously
- messages the user only when something needs them; the user can say what to hear about and how often
- one ongoing thread with the user's memory, skills and connectors
- shows the exact action and waits for approval before sending, paying, signing or deleting

## How Claude Projects works

```
user ──▶ project chat ──▶ Coordinator Claude ──start_thread_session(brief, user msg ids)──▶ Thread Claude
                              │  ▲                                                          │
                              │  └──── digest of all thread messages, about every minute ◀──┘
                              └──▶ message_thread (relay) ──▶ Thread Claude replies in its thread
shared: project memory (one file per fact), /mnt/project-files, project instructions
```

- The coordinator is **recycled** for upgrades and age limits. The new one gets recent chat, recent threads and memory, not the old history.
- Default models: Opus everywhere, **low effort for the coordinator**, high for threads.
- A separate small model writes a **status card** per thread: `needs_reply`, `needs_approval`, `done`, `failed`, `working`.

## What Kimaki already does the same way

- The coordinator answers directly when it can and delegates real work to visible threads.
- It quotes the user's words verbatim instead of rewording them.
- It reads the real diff before reporting, not only the worker's claims ("trust but verify worker reports" in the Claude Code coordinator prompt).
- It stays quiet between results (`IDLE`); Duet "goes quiet until something needs you".
- No internal IDs in replies, only thread links.
- Durable project memory outlives compaction.

## Ideas worth adopting

Prompt-only changes, cheapest first:

1. **Message triage table.** Projects gives one action per kind of user message: new ask, follow-up to a running thread, question memory can answer, greeting or FYI, thanks, members talking to each other. Thanks gets only a reaction; members talking gets nothing. Ours has examples but no table.
2. **Pick a default instead of asking.** "When an ask forks on a detail the user hasn't specified, Claude picks the reasonable default, says which, and keeps going." When a question is needed, the thread still starts and does what it can. Our "refactor the auth module" example asks and starts nothing.
3. **Question format.** "Questions must be answerable with one word, and presented with one short line per option, with Claude's recommendation marked." Maps to `kimaki buttons`.
4. **Brief rule.** The brief carries the user's words and adds only two things: what the thread needs from memory, and the default picked where the ask forks. "It does not add deliverables, tests, checklists, guardrails, artifacts or reporting rules the user or memory never named." Close to ours, but stricter and shorter.
5. **Status on request.** When the user asks for an update: one message, one line per thread with its state and what it waits on, each thread linked. We have no rule for this.
6. **Notification level in memory.** When the user says how much they want to hear (every milestone, only blockers, nothing), that becomes the project default and goes in memory.
7. **Several asks in one message become separate threads**, with one line saying what was split out.
8. **Never say a thread cannot do something.** "A Coordinator Claude never tells a user it can't do something a Thread Claude can. Instead, it routes the work."
9. **Synthesize, never "based on your findings".** From the Claude Code coordinator prompt: the coordinator must understand worker results before it directs follow-up work.
10. **Continue vs spawn exceptions.** We say prefer continuing a worker. Claude Code adds two exceptions: a fresh worker to verify another worker's code, and a fresh worker after a wrong approach, so the failed path does not anchor the retry.
11. **Quote the user's approval.** "When the user has approved a specific action, quote their exact words in the worker's prompt." A relay from the coordinator never counts as user approval for destructive steps.
12. **Memory entries with Why and How to apply**, and relative dates turned into absolute dates.
13. **Report shape from the status card.** Lead with what the user must do now, one verb and one object; say what happened in one sentence with concrete nouns.

Ideas that need code:

| Idea | From | What Kimaki would need |
| --- | --- | --- |
| Tell the user about **stuck threads**: failed turn, lost work, parked on a permission prompt | Projects | wake the coordinator when a worker waits on a permission or question, not only when a run ends |
| **Resolve** a thread when the user takes the last action, such as merging the PR | Projects | archive the Discord thread from the coordinator |
| **Status card** state per finished run (`needs_reply`, `needs_approval`, `done`, `failed`, `working`) | Projects | a state field in the `<session-finished>` note, maybe from a small model |
| **Proactivity level** low, medium, high per project, injected as a reminder | Claude Code | a per-channel setting and plugin text |
| **Coordinator digest** of thread messages about every minute, instead of one note per run end | Projects | batched notes; probably worse for the prompt cache, so likely skip |
| Coordinator at **low effort**, threads at high | Projects docs | a default model or variant for the coordinator session |

Ideas to skip:

- **Always acknowledge in the channel** (`project_ack` plus thread `ack`). We decided on 2026-10-27 to answer `IDLE` after starting a worker because the new thread already shows.
- **Separate trust markers** for server-attributed user messages. Discord already shows who wrote what, and Kimaki workers act for one user.
- **Recycling the coordinator** instead of compacting it. Our compaction plus warm cache covers this.
