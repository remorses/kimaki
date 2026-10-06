// Recorded OpenCode V2 streams (docs/opencode-v2-events) replayed through the
// reducer: what Discord gets for tools, subagents and interrupts (spec 29.3).

import { expect, test } from 'vitest'

import { queuedItems } from './queue.ts'
import { isBusy, type ThreadEvent } from './thread-reducer.ts'
import { effectLines, loadFixture, replay } from './test/replay.ts'

test('tools: names from tool.input.started, failed tool lines, read-only tools hidden, one footer', () => {
  const { effects } = replay({ events: loadFixture('tools.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ shell _ls cli/src \\| head -5_",
      "-# ┣ shell",
      "-# ⨯ shell _Invalid arguments for tool "shell":_",
      "-# ┣ shell",
      "-# ⨯ shell _Invalid arguments for tool "shell":_",
      "-# ┣ shell _mkdir -p tmp-events && printf 'hello' > tmp-events/hello.txt_",
      "-# ┣ shell _python3 -c "from pathlib import Path; p=Path('tmp-events/hello.txt'); p.write\\_t…_",
      "\\nDone. \`tmp-events/hello.txt\` contains \`hello world\`.",
      "[typing off]",
      "-# *project ⋅ main ⋅ 17s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
})

test('tools at text verbosity: text, edits and errors only', () => {
  const { effects } = replay({
    events: loadFixture('tools.events.jsonl'),
    prefs: { verbosity: 'text', contextLimits: {} },
  })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ⨯ shell _Invalid arguments for tool "shell":_",
      "-# ⨯ shell _Invalid arguments for tool "shell":_",
      "\\nDone. \`tmp-events/hello.txt\` contains \`hello world\`.",
      "[typing off]",
      "-# *project ⋅ main ⋅ 17s ⋅ gpt-6-luna*",
    ]
  `)
})

test('task-subagent: child tool lines labelled with the agent, no child text, footer after the parent', () => {
  const { effects, view } = replay({ events: loadFixture('task-subagent.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ general **Find SQLite schema file**",
      "\\nThe Drizzle SQLite schema is defined in \`cli/src/schema.ts\`. Its first lines confirm it defines tables for Kimaki’s local SQLite database.",
      "[typing off]",
      "-# *project ⋅ main ⋅ 12s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
  expect(view.children).toMatchInlineSnapshot(`
    {
      "ses_f0dfdb26dffe4pYPLk3KuNpf4C": {
        "agent": "general",
        "background": false,
        "description": "Find SQLite schema file",
        "running": false,
      },
    }
  `)
})

test('task-parallel: background children show start and end lines only, no footer while a child runs', () => {
  const { effects, view } = replay({ events: loadFixture('task-parallel.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ general **Count command TypeScript** (background)",
      "-# ┣ general **List repo folders** (background)",
      "-# ⬦ general finished: Count command TypeScript",
      "\\nBoth tasks are running. I’ll report the two results when they finish.",
      "\\n-# ┣ general **List repo folders**",
      "-# ┣ general ⋅ shell _find . -maxdepth 1 -type d -not -name . -print \\| sed 's#^./##' \\| sort_",
      "\\n\`.ts\` files in \`cli/src/commands\`: 49  
    Top-level folders: waiting for the second result.",
      "-# ┣ general ⋅ shell _find . -maxdepth 1 -type d -not -name . -print \\| sed 's#^./##' \\| sort_",
    ]
  `)
  expect({ busy: isBusy(view), children: view.children }).toMatchInlineSnapshot(`
    {
      "busy": true,
      "children": {
        "ses_f0dfd7229ffemyliaApRoLQLQ3": {
          "agent": "general",
          "background": false,
          "description": "List repo folders",
          "running": true,
        },
        "ses_f0dfd79e4ffeOWczD5TWjb4IuK": {
          "agent": "general",
          "background": true,
          "description": "Count command TypeScript",
          "running": false,
        },
      },
    }
  `)
})

test('abort: no error line for the aborted tool, no footer, next turn is normal', () => {
  const { effects } = replay({ events: loadFixture('abort.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ shell _sleep 30 && echo never_",
      "[typing off]",
      "[typing on]",
      "resumed after abort",
      "[typing off]",
      "-# *project ⋅ main ⋅ 1s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
})

test('child found by the parentID walk after a restart still gets labelled tool lines', () => {
  const events = loadFixture('task-parallel.events.jsonl')
  const children = events.filter((event) => event.type === 'session.created' && event.data.parentID)
  const child = children[children.length - 1]
  if (child?.type !== 'session.created') throw new Error('fixture has no child session')
  // The bot restarted after the child was created: no session.created, no tool.progress link.
  const afterRestart = events.flatMap((event): ThreadEvent[] => {
    if (event === child) return [{ type: 'kimaki.child', sessionId: child.data.sessionID, agent: 'general' }]
    if (event.type === 'session.tool.progress' && event.data.metadata['sessionID'] === child.data.sessionID) return []
    return [event]
  })
  const { effects } = replay({ events: afterRestart })
  expect(effectLines(effects).filter((line) => line.includes('general ⋅'))).toMatchInlineSnapshot(`
    [
      "-# ┣ general ⋅ shell _find . -maxdepth 1 -type d -not -name . -print \\| sed 's#^./##' \\| sort_",
      "-# ┣ general ⋅ shell _find . -maxdepth 1 -type d -not -name . -print \\| sed 's#^./##' \\| sort_",
    ]
  `)
})

test('parallel children created out of call order get the right label and mode', () => {
  const events = loadFixture('task-parallel.events.jsonl')
  const root = events.find((event) => event.type === 'session.created' && !event.data.parentID)
  const calls = events.filter(
    (event) =>
      (event.type === 'session.tool.input.started' && event.data.name === 'subagent') ||
      (event.type === 'session.tool.called' && event.data.input['background'] === true),
  )
  const [childA, childB] = events.filter((event) => event.type === 'session.created' && event.data.parentID)
  const progress = events.filter((event) => event.type === 'session.tool.progress' && event.data.metadata['sessionID'])
  const [progressA, progressB] = progress
  if (!root || !childA || !childB || !progressA || !progressB) throw new Error('fixture changed')
  // Both calls first, then child B is created and linked before child A.
  const { view } = replay({ events: [root, ...calls.slice(0, 4), childB, progressB, childA, progressA] })
  expect(view.children).toMatchInlineSnapshot(`
    {
      "ses_f0dfd7229ffemyliaApRoLQLQ3": {
        "agent": "general",
        "background": true,
        "description": "List repo folders",
        "running": false,
      },
      "ses_f0dfd79e4ffeOWczD5TWjb4IuK": {
        "agent": "general",
        "background": true,
        "description": "Count command TypeScript",
        "running": false,
      },
    }
  `)
})

test('queue-plain: acks with positions while busy, echo per delivered item, one footer', () => {
  const { effects, view } = replay({ events: loadFixture('queue-plain.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ shell _sleep 6 && echo slow-done_",
      "[show queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# Queued at position 1. Delete the original message to remove it, or use /clear-queue position:1",
      "[show queue:msg_0f20347e500196F4o0voD7LGMV] -# Queued at position 2. Delete the original message to remove it, or use /clear-queue position:2",
      "\\nDone.",
      "[edit queue:msg_0f20347e1001nsJ7W4hOvhBpQb] -# Queued message sent",
      "» **queued:** QUEUED-1: reply with the word apple.",
      "apple",
      "[edit queue:msg_0f20347e500196F4o0voD7LGMV] -# Queued message sent",
      "» **queued:** QUEUED-2: reply with the word cherry.",
      "cherry",
      "[typing off]",
      "-# *project ⋅ main ⋅ 15s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
  expect(view.inbox).toMatchInlineSnapshot(`[]`)
})

test('steer-queue: cancelled item edits its ack, interrupted run has no footer', () => {
  const { effects, view } = replay({ events: loadFixture('steer-queue.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ shell _sleep 8 && echo slow-done_",
      "[show queue:msg_0f200f884001tIpWlHhNB8Y5bv] -# Queued at position 1. Delete the original message to remove it, or use /clear-queue position:1",
      "[show queue:msg_kimaki_queued_b_test1] -# Queued at position 2. Delete the original message to remove it, or use /clear-queue position:2",
      "[show queue:msg_0f200f88a001SXny4FyIMuMPS6] -# Queued at position 3. Delete the original message to remove it, or use /clear-queue position:3",
      "[edit queue:msg_kimaki_queued_b_test1] -# Removed from queue",
      "[typing off]",
      "[typing on]",
      "-# ┣ shell _date_",
      "\\nDone. The current date is Wed Sep 30 2026.",
      "[typing off]",
      "-# *project ⋅ main ⋅ 3s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
  // The recorded order (prompt, then interrupt with resume) parks queued items.
  expect(queuedItems(view).map((item) => item.text)).toMatchInlineSnapshot(`
    [
      "QUEUED-A: after everything, reply with the word apple.",
      "QUEUED-C: reply with the word cherry.",
    ]
  `)
})

test('queue-parked: parked item runs and echoes after the next prompt', () => {
  const { effects } = replay({ events: loadFixture('queue-parked.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ shell _sleep 6 && echo slow-done_",
      "[show queue:msg_0f2039909001oR0GJKPGqxOjml] -# Queued at position 1. Delete the original message to remove it, or use /clear-queue position:1",
      "[typing off]",
      "[typing on]",
      "kiwi",
      "[edit queue:msg_0f2039909001oR0GJKPGqxOjml] -# Queued message sent",
      "» **queued:** PARKED-1: reply with the word apple.",
      "apple",
      "[typing off]",
      "-# *project ⋅ main ⋅ 6s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
})

test('question: one dropdown per question, typing off while waiting, edited on reply', () => {
  const { effects, view } = replay({ events: loadFixture('question.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "[typing off]",
      "[show form:frm_0f1ff0402001MIUy5ATcEElGcr] **Color**
    Which color do you prefer? {Red/Green/Blue/Other} | **Fruits**
    Which fruits do you like? {Apple/Pear/Kiwi/Other}",
      "[typing on]",
      "[edit form:frm_0f1ff0402001MIUy5ATcEElGcr] **Color**
    Which color do you prefer?
    ✓ _green_ | **Fruits**
    Which fruits do you like?
    ✓ _apple, kiwi_",
      "You prefer green, and you like apples and kiwi.",
      "[typing off]",
      "-# *project ⋅ main ⋅ 5s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
  expect(view.forms).toMatchInlineSnapshot(`{}`)
})

test('permission: two requests, the rejected one fails its tool call', () => {
  const { effects, view } = replay({ events: loadFixture('permission.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ shell _echo first_",
      "[typing off]",
      "[show perm:per_0f202b5a4001acFP7sdJdnf7DQ] **Permission required**
    **Type:** \`shell\`
    **Pattern:** \`echo first\` {Accept, Accept Always, Deny}",
      "[typing on]",
      "[edit perm:per_0f202b5a4001acFP7sdJdnf7DQ] **Permission required**
    **Type:** \`shell\`
    **Pattern:** \`echo first\`
    ✓ _Accepted_",
      "-# ┣ shell _echo second_",
      "[typing off]",
      "[show perm:per_0f202be4b001DoNE0gpRKT1aa9] **Permission required**
    **Type:** \`shell\`
    **Pattern:** \`echo second\` {Accept, Accept Always, Deny}",
      "[typing on]",
      "[edit perm:per_0f202be4b001DoNE0gpRKT1aa9] **Permission required**
    **Type:** \`shell\`
    **Pattern:** \`echo second\`
    ✗ _Denied_",
      "-# ⨯ shell _Unable to execute command: echo second_",
      "\\n\`echo first\` printed \`first\`; \`echo second\` failed to execute.",
      "[typing off]",
      "-# *project ⋅ main ⋅ 5s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
  expect(view.permissions).toMatchInlineSnapshot(`{}`)
})

test('shell: user !cmd output while idle and while busy, synthetic items render nothing', () => {
  const { effects } = replay({ events: loadFixture('shell.events.jsonl') })
  expect(effectLines(effects)).toMatchInlineSnapshot(`
    [
      "-# $ echo user-shell-idle && git log --oneline -1",
      "\`\`\`
    user-shell-idle
    05de62d feat: make external opencode session sync opt-in via --enable-sync
    \`\`\`",
      "[typing on]",
      "-# *using openai/gpt-6-luna ⋅ build*",
      "-# ┣ shell _sleep 5_",
      "-# $ echo user-shell-busy",
      "\`\`\`
    user-shell-busy
    \`\`\`",
      "\\nYour shell command printed \`user-shell-idle\` and \`05de62d feat: make external opencode session sync opt-in via --enable-sync\`. The deploy tag is \`v9.9.9\`.",
      "[typing off]",
      "-# *project ⋅ main ⋅ 9s ⋅ 6% ⋅ gpt-6-luna*",
    ]
  `)
})
