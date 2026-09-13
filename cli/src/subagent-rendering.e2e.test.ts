// Native OpenCode v2 subagents route child tools and survive durable replay.

import type { SessionLogOutput, V2Event } from '@opencode/client'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

import { getThreadSession } from './database.js'
import { getOpencodeClient } from './opencode.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import {
  getDerivedSubagentSessions,
  getDerivedSubtaskAgentType,
  getDerivedSubtaskIndex,
  isEventForSessionTree,
  type EventBufferEntry,
} from './session-handler/event-stream-state.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'

const channelId = '200000000000001071'
const parentMarker = 'NATIVE_SUBAGENT_PARENT'
const childMarker = 'NATIVE_SUBAGENT_CHILD'
const parallelParentMarker = 'PARALLEL_SUBAGENT_PARENT'
const parallelChildAMarker = 'PARALLEL_SUBAGENT_CHILD_A'
const parallelChildBMarker = 'PARALLEL_SUBAGENT_CHILD_B'
const childFinalText = 'Native child completed'
const parentFinalText = 'Parent received native child'
const parallelParentFinalText = 'Parent received parallel native children'

const ctx = setupQueueAdvancedSuite({
  channelId,
  channelName: 'subagent-rendering',
  dirName: 'subagent-rendering',
  username: 'subagent-tester',
  projectPermission: {
    permissions: [{ action: 'subagent', resource: '*', effect: 'allow' }],
  },
  extraMatchers: [
    {
      id: 'native-subagent-parent',
      priority: 500,
      when: {
        lastMessageRole: 'user',
        latestUserTextIncludes: parentMarker,
        latestUserTextExcludes: childMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'native-subagent-call',
            toolName: 'subagent',
            input: JSON.stringify({
              agent: 'explore',
              description: 'Inspect child routing',
              prompt: `${childMarker}: run the harmless shell check and report completion`,
            }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      },
    },
    {
      id: 'native-subagent-child-tool',
      priority: 520,
      when: {
        lastMessageRole: 'user',
        latestUserTextIncludes: childMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'child-intro' },
          {
            type: 'text-delta',
            id: 'child-intro',
            delta: 'Child is checking the native tool route',
          },
          { type: 'text-end', id: 'child-intro' },
          {
            type: 'tool-call',
            toolCallId: 'native-child-shell-call',
            toolName: 'shell',
            input: JSON.stringify({ command: 'echo native-child-tool-ok' }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          },
        ],
      },
    },
    {
      id: 'native-subagent-child-finish',
      priority: 530,
      when: {
        lastMessageRole: 'tool',
        latestUserTextIncludes: childMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'child-finish' },
          { type: 'text-delta', id: 'child-finish', delta: childFinalText },
          { type: 'text-end', id: 'child-finish' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          },
        ],
      },
    },
    {
      id: 'native-subagent-parent-finish',
      priority: 510,
      when: {
        lastMessageRole: 'tool',
        latestUserTextIncludes: parentMarker,
        latestUserTextExcludes: childMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'parent-finish' },
          { type: 'text-delta', id: 'parent-finish', delta: parentFinalText },
          { type: 'text-end', id: 'parent-finish' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          },
        ],
      },
    },
    {
      id: 'parallel-subagent-parent',
      priority: 540,
      when: {
        lastMessageRole: 'user',
        latestUserTextIncludes: parallelParentMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'parallel-subagent-call-a',
            toolName: 'subagent',
            input: JSON.stringify({
              agent: 'explore',
              description: 'Inspect first sibling',
              prompt: `${parallelChildAMarker}: run the first harmless shell check`,
            }),
          },
          {
            type: 'tool-call',
            toolCallId: 'parallel-subagent-call-b',
            toolName: 'subagent',
            input: JSON.stringify({
              agent: 'explore',
              description: 'Inspect second sibling',
              prompt: `${parallelChildBMarker}: run the second harmless shell check`,
            }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      },
    },
    {
      id: 'parallel-subagent-child-a-tool',
      priority: 560,
      when: {
        lastMessageRole: 'user',
        latestUserTextIncludes: parallelChildAMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'parallel-child-a-shell',
            toolName: 'shell',
            input: JSON.stringify({ command: 'echo parallel-child-a-ok' }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          },
        ],
      },
    },
    {
      id: 'parallel-subagent-child-b-tool',
      priority: 560,
      when: {
        lastMessageRole: 'user',
        latestUserTextIncludes: parallelChildBMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'parallel-child-b-shell',
            toolName: 'shell',
            input: JSON.stringify({ command: 'echo parallel-child-b-ok' }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          },
        ],
      },
    },
    {
      id: 'parallel-subagent-child-a-finish',
      priority: 570,
      when: {
        lastMessageRole: 'tool',
        latestUserTextIncludes: parallelChildAMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'parallel-child-a-finish' },
          { type: 'text-delta', id: 'parallel-child-a-finish', delta: 'First sibling completed' },
          { type: 'text-end', id: 'parallel-child-a-finish' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          },
        ],
      },
    },
    {
      id: 'parallel-subagent-child-b-finish',
      priority: 570,
      when: {
        lastMessageRole: 'tool',
        latestUserTextIncludes: parallelChildBMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'parallel-child-b-finish' },
          { type: 'text-delta', id: 'parallel-child-b-finish', delta: 'Second sibling completed' },
          { type: 'text-end', id: 'parallel-child-b-finish' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          },
        ],
      },
    },
    {
      id: 'parallel-subagent-parent-finish',
      priority: 550,
      when: {
        lastMessageRole: 'tool',
        latestUserTextIncludes: parallelParentMarker,
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'parallel-parent-finish' },
          { type: 'text-delta', id: 'parallel-parent-finish', delta: parallelParentFinalText },
          { type: 'text-end', id: 'parallel-parent-finish' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
          },
        ],
      },
    },
  ],
})

type ReplayEventType =
  | 'session.created'
  | 'session.execution.started'
  | 'session.execution.succeeded'
  | 'session.execution.failed'
  | 'session.execution.interrupted'
  | 'session.text.ended'
  | 'session.tool.input.started'
  | 'session.tool.called'
  | 'session.tool.success'

type DurableV2Event = Extract<V2Event, { type: ReplayEventType }>

type NormalizedDurableEvent = {
  type: string
  session: string
  parent?: string
  agent?: string
  title?: string
  name?: string
  input?: object
  content?: string
  text?: string
  metadata?: { session: string; status?: string }
}

async function readSessionLog({ sessionID }: { sessionID: string }): Promise<SessionLogOutput[]> {
  const client = getOpencodeClient(ctx.directories.projectDirectory)
  if (!client) throw new Error('Missing OpenCode client')

  const events: SessionLogOutput[] = []
  for await (const event of client.session.log({ sessionID })) events.push(event)
  return events
}

async function readCapturedEvents({ sessionID }: { sessionID: string }): Promise<DurableV2Event[]> {
  const filePath = path.join(ctx.directories.root, 'opencode-session-events', `${sessionID}.jsonl`)
  const contents = await fs.promises.readFile(filePath, 'utf8')
  return contents
    .trim()
    .split('\n')
    .flatMap((line): DurableV2Event[] => {
      const event = JSON.parse(line) as V2Event
      if (event.type === 'session.created') return [event]
      if (event.type === 'session.execution.started') return [event]
      if (event.type === 'session.execution.succeeded') return [event]
      if (event.type === 'session.execution.failed') return [event]
      if (event.type === 'session.execution.interrupted') return [event]
      if (event.type === 'session.text.ended') return [event]
      if (event.type === 'session.tool.input.started') return [event]
      if (event.type === 'session.tool.called') return [event]
      if (event.type === 'session.tool.success') return [event]
      return []
    })
}

function textContent(
  event: Extract<
    V2Event,
    {
      type: 'session.tool.success'
    }
  >,
): string {
  return event.data.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
}

function normalizeDurableSequence({
  events,
  mainSessionID,
  childSessionID,
}: {
  events: DurableV2Event[]
  mainSessionID: string
  childSessionID: string
}): NormalizedDurableEvent[] {
  const role = (sessionID: string) => {
    if (sessionID === mainSessionID) return 'main'
    if (sessionID === childSessionID) return 'child'
    return 'other'
  }
  return events.flatMap((event): NormalizedDurableEvent[] => {
    if (event.type === 'session.created') {
      return [
        {
          type: event.type,
          session: role(event.data.sessionID),
          parent: event.data.parentID ? role(event.data.parentID) : undefined,
          agent: event.data.agent,
          title: event.data.title,
        },
      ]
    }
    if (event.type === 'session.tool.input.started') {
      return [
        {
          type: event.type,
          session: role(event.data.sessionID),
          name: event.data.name,
        },
      ]
    }
    if (event.type === 'session.tool.called') {
      return [
        {
          type: event.type,
          session: role(event.data.sessionID),
          input: event.data.input,
        },
      ]
    }
    if (event.type === 'session.tool.success') {
      return [
        {
          type: event.type,
          session: role(event.data.sessionID),
          content: textContent(event)
            .replaceAll(mainSessionID, '<main-session>')
            .replaceAll(childSessionID, '<child-session>'),
          metadata: event.data.metadata?.['sessionID']
            ? {
                session: role(String(event.data.metadata['sessionID'])),
                status:
                  typeof event.data.metadata['status'] === 'string'
                    ? event.data.metadata['status']
                    : undefined,
              }
            : undefined,
        },
      ]
    }
    if (event.type === 'session.text.ended') {
      return [
        {
          type: event.type,
          session: role(event.data.sessionID),
          text: event.data.text,
        },
      ]
    }
    if (
      event.type === 'session.execution.started' ||
      event.type === 'session.execution.succeeded' ||
      event.type === 'session.execution.failed' ||
      event.type === 'session.execution.interrupted'
    ) {
      return [{ type: event.type, session: role(event.data.sessionID) }]
    }
    return []
  })
}

test('routes one native child tool and replays captured durable event shapes', async () => {
  await ctx.discord
    .channel(channelId)
    .user(TEST_USER_ID)
    .sendMessage({
      content: `${parentMarker}: delegate this check`,
    })
  const thread = await ctx.discord.channel(channelId).waitForThread({ timeout: 4_000 })
  await waitForBotMessageContaining({
    discord: ctx.discord,
    threadId: thread.id,
    userId: TEST_USER_ID,
    afterUserMessageIncludes: parentMarker,
    text: parentFinalText,
    timeout: 4_000,
    clamp: false,
  })
  await waitForFooterMessage({
    discord: ctx.discord,
    threadId: thread.id,
    afterMessageIncludes: parentMarker,
    afterAuthorId: TEST_USER_ID,
    timeout: 4_000,
    clamp: false,
  })

  const th = ctx.discord.thread(thread.id)
  expect(await th.text()).toMatchInlineSnapshot(`
    "--- from: user (subagent-tester)
    NATIVE_SUBAGENT_PARENT: delegate this check
    --- from: assistant (TestBot)
    > *using deterministic-provider/deterministic-v2*
    ▏explore-1 ⋅ shell _echo native-child-tool-ok_

    Parent received native child
    > *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000991>"
  `)

  const mainSessionID = await getThreadSession(thread.id)
  if (!mainSessionID) throw new Error('Missing main OpenCode session')
  const client = getOpencodeClient(ctx.directories.projectDirectory)
  if (!client) throw new Error('Missing OpenCode client')
  const children = await client.session.list({
    parentID: mainSessionID,
    limit: 100,
    order: 'asc',
  })
  expect(children.data).toHaveLength(1)
  const child = children.data[0]
  if (!child) throw new Error('Missing native child session')

  const [mainLog, childLog, mainEvents, childEvents] = await Promise.all([
    readSessionLog({ sessionID: mainSessionID }),
    readSessionLog({ sessionID: child.id }),
    readCapturedEvents({ sessionID: mainSessionID }),
    readCapturedEvents({ sessionID: child.id }),
  ])
  // CLI `serve` does not enable event persistence, so the durable endpoint only syncs.
  expect(mainLog.map((event) => event.type)).toEqual(['log.synced'])
  expect(childLog.map((event) => event.type)).toEqual(['log.synced'])

  const replayEvents = [...mainEvents, ...childEvents].sort((left, right) => {
    if (left.created !== right.created) return left.created - right.created
    if (left.durable.aggregateID !== right.durable.aggregateID) {
      return left.durable.aggregateID.localeCompare(right.durable.aggregateID)
    }
    return left.durable.seq - right.durable.seq
  })
  const replayBuffer: EventBufferEntry[] = replayEvents.map((event) => ({
    event,
    timestamp: event.created,
  }))

  expect(
    normalizeDurableSequence({
      events: replayEvents,
      mainSessionID,
      childSessionID: child.id,
    }),
  ).toMatchInlineSnapshot(`
    [
      {
        "agent": undefined,
        "parent": undefined,
        "session": "main",
        "title": undefined,
        "type": "session.created",
      },
      {
        "session": "main",
        "type": "session.execution.started",
      },
      {
        "name": "subagent",
        "session": "main",
        "type": "session.tool.input.started",
      },
      {
        "input": {
          "agent": "explore",
          "description": "Inspect child routing",
          "prompt": "NATIVE_SUBAGENT_CHILD: run the harmless shell check and report completion",
        },
        "session": "main",
        "type": "session.tool.called",
      },
      {
        "agent": "explore",
        "parent": "main",
        "session": "child",
        "title": "Inspect child routing",
        "type": "session.created",
      },
      {
        "session": "child",
        "type": "session.execution.started",
      },
      {
        "session": "child",
        "text": "Child is checking the native tool route",
        "type": "session.text.ended",
      },
      {
        "name": "shell",
        "session": "child",
        "type": "session.tool.input.started",
      },
      {
        "input": {
          "command": "echo native-child-tool-ok",
        },
        "session": "child",
        "type": "session.tool.called",
      },
      {
        "content": "native-child-tool-ok

    Command exited with code 0.",
        "metadata": undefined,
        "session": "child",
        "type": "session.tool.success",
      },
      {
        "session": "child",
        "text": "Native child completed",
        "type": "session.text.ended",
      },
      {
        "session": "child",
        "type": "session.execution.succeeded",
      },
      {
        "content": "<subagent sessionID="<child-session>" state="completed">
    Native child completed
    </subagent>",
        "metadata": {
          "session": "child",
          "status": "completed",
        },
        "session": "main",
        "type": "session.tool.success",
      },
      {
        "session": "main",
        "text": "Parent received native child",
        "type": "session.text.ended",
      },
      {
        "session": "main",
        "type": "session.execution.succeeded",
      },
    ]
  `)

  const replayedChildren = getDerivedSubagentSessions({
    events: replayBuffer,
    mainSessionId: mainSessionID,
  })
  expect(replayedChildren).toHaveLength(1)
  expect(replayedChildren[0]).toMatchObject({
    childSessionId: child.id,
    subagentType: 'explore',
    description: 'Inspect child routing',
  })
  expect(
    getDerivedSubtaskAgentType({
      events: replayBuffer,
      mainSessionId: mainSessionID,
      candidateSessionId: child.id,
    }),
  ).toBe('explore')
  expect(
    getDerivedSubtaskIndex({
      events: replayBuffer,
      mainSessionId: mainSessionID,
      candidateSessionId: child.id,
    }),
  ).toBe(1)
  expect(
    childEvents.every((event) =>
      isEventForSessionTree({
        events: replayBuffer,
        event,
        mainSessionId: mainSessionID,
      }),
    ),
  ).toBe(true)

  const childTexts = childEvents.flatMap((event) => {
    return event.type === 'session.text.ended' ? [event.data.text] : []
  })
  expect(childTexts).toEqual(['Child is checking the native tool route', childFinalText])
  const childTool = childEvents.find((event) => {
    return event.type === 'session.tool.success'
  })
  if (!childTool || childTool.type !== 'session.tool.success') {
    throw new Error('Missing child tool success')
  }
  expect(textContent(childTool)).toContain('native-child-tool-ok')
}, 15_000)

test('keeps distinct parallel child labels live and after durable replay', async () => {
  const leftoverThreadIds = new Set(
    (await ctx.discord.channel(channelId).getThreads()).map((thread) => thread.id),
  )
  await ctx.discord
    .channel(channelId)
    .user(TEST_USER_ID)
    .sendMessage({
      content: `${parallelParentMarker}: delegate both checks`,
    })
  const thread = await ctx.discord.channel(channelId).waitForThread({
    timeout: 4_000,
    predicate: (candidate) => !leftoverThreadIds.has(candidate.id),
  })
  const th = ctx.discord.thread(thread.id)
  await waitForBotMessageContaining({
    discord: ctx.discord,
    threadId: thread.id,
    userId: TEST_USER_ID,
    afterUserMessageIncludes: parallelParentMarker,
    text: 'explore-1',
    timeout: 4_000,
  })
  await waitForBotMessageContaining({
    discord: ctx.discord,
    threadId: thread.id,
    userId: TEST_USER_ID,
    afterUserMessageIncludes: parallelParentMarker,
    text: 'explore-2',
    timeout: 4_000,
  })
  const liveText = await th.text()
  expect(liveText).toContain(parallelParentMarker)
  expect(liveText.split('\n').filter((line) => line.includes('explore-1'))).toHaveLength(1)
  expect(liveText.split('\n').filter((line) => line.includes('explore-2'))).toHaveLength(1)
  expect(liveText).not.toContain(parallelParentFinalText)

  await waitForBotMessageContaining({
    discord: ctx.discord,
    threadId: thread.id,
    userId: TEST_USER_ID,
    afterUserMessageIncludes: parallelParentMarker,
    text: parallelParentFinalText,
    timeout: 4_000,
    clamp: false,
  })
  await waitForFooterMessage({
    discord: ctx.discord,
    threadId: thread.id,
    afterMessageIncludes: parallelParentMarker,
    afterAuthorId: TEST_USER_ID,
    timeout: 4_000,
    clamp: false,
  })

  const finishedText = await th.text()
  const snapshotText = finishedText.replace(
    /(▏explore-\d[^\n]*\n▏explore-\d[^\n]*)/,
    (match) => match.split('\n').sort().join('\n'),
  )
  expect(snapshotText).toMatchInlineSnapshot(`
    "--- from: user (subagent-tester)
    PARALLEL_SUBAGENT_PARENT: delegate both checks
    --- from: assistant (TestBot)
    > *using deterministic-provider/deterministic-v2*
    ▏explore-1 ⋅ shell _echo parallel-child-a-ok_
    ▏explore-2 ⋅ shell _echo parallel-child-b-ok_

    Parent received parallel native children
    > *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000991>"
  `)
  expect(finishedText.split('\n').filter((line) => {
    return line.includes('shell _echo parallel-child-a-ok_')
  })).toHaveLength(1)
  expect(finishedText.split('\n').filter((line) => {
    return line.includes('shell _echo parallel-child-b-ok_')
  })).toHaveLength(1)

  const mainSessionID = await getThreadSession(thread.id)
  if (!mainSessionID) throw new Error('Missing main OpenCode session')
  const client = getOpencodeClient(ctx.directories.projectDirectory)
  if (!client) throw new Error('Missing OpenCode client')
  const children = await client.session.list({
    parentID: mainSessionID,
    limit: 100,
    order: 'asc',
  })
  expect(children.data).toHaveLength(2)
  const firstChild = children.data[0]
  const secondChild = children.data[1]
  if (!firstChild || !secondChild) throw new Error('Missing native child sessions')

  const [mainEvents, firstEvents, secondEvents] = await Promise.all([
    readCapturedEvents({ sessionID: mainSessionID }),
    readCapturedEvents({ sessionID: firstChild.id }),
    readCapturedEvents({ sessionID: secondChild.id }),
  ])
  const replayEvents = [...mainEvents, ...firstEvents, ...secondEvents].sort((left, right) => {
    if (left.created !== right.created) return left.created - right.created
    if (left.durable.aggregateID !== right.durable.aggregateID) {
      return left.durable.aggregateID.localeCompare(right.durable.aggregateID)
    }
    return left.durable.seq - right.durable.seq
  })
  const replayBuffer: EventBufferEntry[] = replayEvents.map((event) => ({
    event,
    timestamp: event.created,
  }))

  expect(getDerivedSubtaskIndex({
    events: replayBuffer,
    mainSessionId: mainSessionID,
    candidateSessionId: firstChild.id,
  })).not.toBe(getDerivedSubtaskIndex({
    events: replayBuffer,
    mainSessionId: mainSessionID,
    candidateSessionId: secondChild.id,
  }))
  expect([
    getDerivedSubtaskIndex({
      events: replayBuffer,
      mainSessionId: mainSessionID,
      candidateSessionId: firstChild.id,
    }),
    getDerivedSubtaskIndex({
      events: replayBuffer,
      mainSessionId: mainSessionID,
      candidateSessionId: secondChild.id,
    }),
  ].sort()).toEqual([1, 2])
  expect(getDerivedSubtaskAgentType({
    events: replayBuffer,
    mainSessionId: mainSessionID,
    candidateSessionId: firstChild.id,
  })).toBe('explore')
  expect(getDerivedSubtaskAgentType({
    events: replayBuffer,
    mainSessionId: mainSessionID,
    candidateSessionId: secondChild.id,
  })).toBe('explore')
}, 15_000)
