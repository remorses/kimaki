// Phase 2: what a normal turn looks like in Discord. Tool lines with V2 tool
// names and verbosity, markdown tables and callouts as Components V2, long
// text split into valid messages, and foreground subagent tool lines.

import fs from 'node:fs'
import path from 'node:path'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

function textParts(text: string): DeterministicMatcher['then']['parts'] {
  return [
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason: 'stop', usage },
  ]
}

function toolParts(toolCallId: string, toolName: string, input: unknown): DeterministicMatcher['then']['parts'] {
  return [
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: 'tool-calls', usage },
  ]
}

// Each step of a scripted turn matches on the tool call id of the previous
// step, which is in the raw prompt only after that tool ran.
function scriptedTurn({
  marker,
  steps,
  finalText,
}: {
  marker: string
  steps: Array<{ id: string; tool: string; input: unknown }>
  finalText: string
}): DeterministicMatcher[] {
  const toolMatchers = steps.map((step, index): DeterministicMatcher => {
    const previous = steps[index - 1]
    return {
      id: `${marker}-${step.id}`,
      priority: 100 + index,
      when: { latestUserTextIncludes: marker, ...(previous && { rawPromptIncludes: previous.id }) },
      then: { parts: toolParts(step.id, step.tool, step.input) },
    }
  })
  const last = steps[steps.length - 1]
  return [
    ...toolMatchers,
    {
      id: `${marker}-final`,
      priority: 100 + steps.length,
      when: { latestUserTextIncludes: marker, ...(last && { rawPromptIncludes: last.id }) },
      then: { parts: textParts(finalText) },
    },
  ]
}

const LONG_CODE = Array.from({ length: 80 }, (_, index) => `const value${index} = compute(${index}) // line ${index}`).join(
  '\n',
)

const MARKDOWN_ANSWER = [
  '## Results',
  '',
  'Two files changed. Details below.',
  '',
  '| File | Change |',
  '| --- | --- |',
  '| `src/a.ts` | added [docs](https://kimaki.dev) link |',
  '| `src/b.ts` | removed dead code |',
  '',
  '<callout accent="#f59e0b">',
  '## Tests not fully green',
  '',
  '- `pnpm test` failed in `cli.test.ts`',
  '</callout>',
  '',
  '```ts',
  LONG_CODE,
  '```',
].join('\n')

const matchers: DeterministicMatcher[] = [
  ...scriptedTurn({
    marker: 'tools-marker',
    steps: [
      { id: 'call-shell-1', tool: 'shell', input: { command: 'echo kimaki-shell-ok' } },
      { id: 'call-read-1', tool: 'read', input: { path: 'notes.md' } },
      { id: 'call-edit-1', tool: 'edit', input: { path: 'notes.md', oldString: 'first line', newString: 'first line\nsecond line' } },
    ],
    finalText: 'Edited notes.md.',
  }),
  {
    id: 'markdown',
    priority: 100,
    when: { latestUserTextIncludes: 'markdown-marker' },
    then: { parts: textParts(MARKDOWN_ANSWER) },
  },
  ...scriptedTurn({
    marker: 'subagent-marker',
    steps: [
      {
        id: 'call-subagent-1',
        tool: 'subagent',
        input: { agent: 'general', description: 'Find markdown files', prompt: 'child-marker list the markdown files' },
      },
    ],
    finalText: 'The child found notes.md.',
  }),
  ...scriptedTurn({
    marker: 'child-marker',
    steps: [{ id: 'call-child-shell-1', tool: 'shell', input: { command: 'ls *.md' } }],
    finalText: 'notes.md',
  }).map((matcher) => ({ ...matcher, priority: (matcher.priority ?? 0) + 100 })),
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin()])
  await seedProjectChannel({
    dataDir,
    channelId: twin.channelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
  })
  await seedProjectChannel({
    dataDir,
    channelId: twin.quietChannelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
    verbosity: 'text',
  })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function runTurn({ channelId, content }: { channelId: string; content: string }) {
  fs.writeFileSync(path.join(server.projectDirectory, 'notes.md'), 'first line\n')
  const { discord } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content })
  const thread = await discord.channel(channelId).waitForThread({
    timeout: 8_000,
    predicate: (candidate) => !before.has(candidate.id),
  })
  await waitForFooter({ discord, threadId: thread.id })
  return thread
}

test('shell and edit lines are shown, read is hidden at the default verbosity', async () => {
  const thread = await runTurn({ channelId: twin.channelId, content: 'Use tools tools-marker' })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Use tools tools-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ shell _echo kimaki-shell-ok_
    -# ◼︎ edit *notes.md* (+1-0)

    Edited notes.md.
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('table and callout render as components, long code splits into valid messages', async () => {
  const thread = await runTurn({ channelId: twin.channelId, content: 'Summarize markdown-marker' })
  const messages = await twin.discord.thread(thread.id).getMessages()
  expect(
    messages.map((message) => ({
      components: (message.components ?? []).length > 0,
      length: message.content.length,
      fences: (message.content.match(/```/g) ?? []).length,
    })),
  ).toMatchInlineSnapshot(`
    [
      {
        "components": false,
        "fences": 0,
        "length": 25,
      },
      {
        "components": false,
        "fences": 0,
        "length": 58,
      },
      {
        "components": false,
        "fences": 0,
        "length": 45,
      },
      {
        "components": true,
        "fences": 0,
        "length": 0,
      },
      {
        "components": true,
        "fences": 0,
        "length": 0,
      },
      {
        "components": false,
        "fences": 2,
        "length": 1968,
      },
      {
        "components": false,
        "fences": 2,
        "length": 1140,
      },
      {
        "components": false,
        "fences": 0,
        "length": 49,
      },
    ]
  `)
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Summarize markdown-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ## Results

    Two files changed. Details below.
    **File** \`src/a.ts\`
    **Change** added [docs](https://kimaki.dev) link
    ---
    **File** \`src/b.ts\`
    **Change** removed dead code
    ## Tests not fully green

    - \`pnpm test\` failed in \`cli.test.ts\`
    \`\`\`ts
    const value0 = compute(0) // line 0
    const value1 = compute(1) // line 1
    const value2 = compute(2) // line 2
    const value3 = compute(3) // line 3
    const value4 = compute(4) // line 4
    const value5 = compute(5) // line 5
    const value6 = compute(6) // line 6
    const value7 = compute(7) // line 7
    const value8 = compute(8) // line 8
    const value9 = compute(9) // line 9
    const value10 = compute(10) // line 10
    const value11 = compute(11) // line 11
    const value12 = compute(12) // line 12
    const value13 = compute(13) // line 13
    const value14 = compute(14) // line 14
    const value15 = compute(15) // line 15
    const value16 = compute(16) // line 16
    const value17 = compute(17) // line 17
    const value18 = compute(18) // line 18
    const value19 = compute(19) // line 19
    const value20 = compute(20) // line 20
    const value21 = compute(21) // line 21
    const value22 = compute(22) // line 22
    const value23 = compute(23) // line 23
    const value24 = compute(24) // line 24
    const value25 = compute(25) // line 25
    const value26 = compute(26) // line 26
    const value27 = compute(27) // line 27
    const value28 = compute(28) // line 28
    const value29 = compute(29) // line 29
    const value30 = compute(30) // line 30
    const value31 = compute(31) // line 31
    const value32 = compute(32) // line 32
    const value33 = compute(33) // line 33
    const value34 = compute(34) // line 34
    const value35 = compute(35) // line 35
    const value36 = compute(36) // line 36
    const value37 = compute(37) // line 37
    const value38 = compute(38) // line 38
    const value39 = compute(39) // line 39
    const value40 = compute(40) // line 40
    const value41 = compute(41) // line 41
    const value42 = compute(42) // line 42
    const value43 = compute(43) // line 43
    const value44 = compute(44) // line 44
    const value45 = compute(45) // line 45
    const value46 = compute(46) // line 46
    const value47 = compute(47) // line 47
    const value48 = compute(48) // line 48
    const value49 = compute(49) // line 49
    const value50 = compute(50) // line 50
    \`\`\`
    \`\`\`ts
    const value51 = compute(51) // line 51
    const value52 = compute(52) // line 52
    const value53 = compute(53) // line 53
    const value54 = compute(54) // line 54
    const value55 = compute(55) // line 55
    const value56 = compute(56) // line 56
    const value57 = compute(57) // line 57
    const value58 = compute(58) // line 58
    const value59 = compute(59) // line 59
    const value60 = compute(60) // line 60
    const value61 = compute(61) // line 61
    const value62 = compute(62) // line 62
    const value63 = compute(63) // line 63
    const value64 = compute(64) // line 64
    const value65 = compute(65) // line 65
    const value66 = compute(66) // line 66
    const value67 = compute(67) // line 67
    const value68 = compute(68) // line 68
    const value69 = compute(69) // line 69
    const value70 = compute(70) // line 70
    const value71 = compute(71) // line 71
    const value72 = compute(72) // line 72
    const value73 = compute(73) // line 73
    const value74 = compute(74) // line 74
    const value75 = compute(75) // line 75
    const value76 = compute(76) // line 76
    const value77 = compute(77) // line 77
    const value78 = compute(78) // line 78
    const value79 = compute(79) // line 79
    \`\`\`
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('foreground subagent: child tool lines labelled with the agent, one footer', async () => {
  const thread = await runTurn({ channelId: twin.channelId, content: 'Delegate subagent-marker' })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Delegate subagent-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ general **Find markdown files**
    -# ┣ general ⋅ shell _ls \\*.md_

    The child found notes.md.
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('channel verbosity text shows only text and edit lines', async () => {
  const thread = await runTurn({ channelId: twin.quietChannelId, content: 'Use tools tools-marker' })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Use tools tools-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ◼︎ edit *notes.md* (+1-0)

    Edited notes.md.
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
