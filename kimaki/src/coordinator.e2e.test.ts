// Coordinator channels: the channel is the conversation of one long session, it
// starts worker threads with `kimaki send --parent-session`, and a finished
// worker wakes it with a <session-finished> note.

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { send } from './prompt.ts'
import { readSessionMarkdown } from './session-events.ts'
import {
  TEST_USER_ID,
  isFooter,
  scriptedTurn,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitFor,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
const dataDir = tempDataDir()

beforeAll(async () => {
  // The twin first: the delegating matcher needs its channel ID.
  twin = await startTwin()
  server = await startOpencodeTestServer({
      matchers: [
        { id: 'hello', priority: 100, when: { latestUserTextIncludes: 'hello-marker' }, then: { parts: textParts('Hello from the coordinator.') } },
        // The coordinator delegates: one shell call to `kimaki send`, then IDLE (the new thread already shows).
        ...scriptedTurn({
          marker: 'delegate-marker',
          steps: [{
            id: 'call-send-worker',
            tool: 'shell',
            input: {
              command: `kimaki send --channel ${twin.channelId} --name 'Worker task' --prompt 'worker-marker do the job' --parent-session "$OPENCODE_SESSION_ID"`,
              description: 'Start the worker thread',
              hasSideEffect: true,
            },
          }],
          finalText: 'IDLE',
        }),
        // The default: the coordinator waits for the worker in the same shell call.
        ...scriptedTurn({
          marker: 'waitjob-marker',
          steps: [{
            id: 'call-send-wait',
            tool: 'shell',
            input: {
              command: `kimaki send --channel ${twin.channelId} --name 'Waited task' --prompt 'waited-worker-marker do the job' --parent-session "$OPENCODE_SESSION_ID" --wait`,
              description: 'Run the worker and wait',
              hasSideEffect: true,
            },
          }],
          finalText: 'The waited worker is done.',
        }),
        { id: 'waited-worker', priority: 100, when: { latestUserTextIncludes: 'waited-worker-marker' }, then: { parts: textParts('Waited job done.') } },
        // A bounded wait runs out; the coordinator is still busy when the worker ends, so the note must still come.
        ...scriptedTurn({
          marker: 'boundedwait-marker',
          steps: [
            {
              id: 'call-send-bounded',
              tool: 'shell',
              input: {
                command: `kimaki send --channel ${twin.channelId} --name 'Bounded task' --prompt 'boundedwait-job-marker do the job' --parent-session "$OPENCODE_SESSION_ID" --wait 0.1`,
                description: 'Start the worker, wait briefly',
                hasSideEffect: true,
              },
            },
            { id: 'call-stay-busy', tool: 'shell', input: { command: 'sleep 2', description: 'Stay busy', hasSideEffect: false } },
          ],
          finalText: 'IDLE',
        }),
        { id: 'bounded-worker', priority: 100, when: { latestUserTextIncludes: 'boundedwait-job-marker' }, then: { parts: textParts('Bounded job done.'), defaultPartDelayMs: 100 } },
        { id: 'woken-by-bounded', priority: 345, when: { latestUserTextRegex: '<session-finished[\\s\\S]*Bounded job done' }, then: { parts: textParts('The bounded job finished.') } },
        // Slow enough that the delegating run ends first: the note then wakes an idle coordinator.
        { id: 'worker', priority: 100, when: { latestUserTextIncludes: 'worker-marker' }, then: { parts: textParts('Job done in the worker.'), defaultPartDelayMs: 300 } },
        // A worker that uploads a screenshot; session read lists its URL, the note does not.
        ...scriptedTurn({
          marker: 'upload-marker',
          steps: [{ id: 'call-upload', tool: 'shell', input: { command: 'kimaki upload-to-discord shot.png', description: 'Upload the screenshot', hasSideEffect: true } }],
          finalText: 'Took the screenshot.',
        }),
        { id: 'woken-with-media', priority: 320, when: { latestUserTextRegex: '<session-finished[\\s\\S]*Took the screenshot' }, then: { parts: textParts('Here is the screenshot.') } },
        { id: 'user-steer', priority: 100, when: { latestUserTextIncludes: 'user-steer-marker' }, then: { parts: textParts('Steered job done.') } },
        { id: 'follow-up', priority: 100, when: { latestUserTextIncludes: 'follow-up-marker' }, then: { parts: textParts('Follow-up done.') } },
        { id: 'woken-by-follow-up', priority: 340, when: { latestUserTextRegex: '<session-finished[\\s\\S]*Follow-up done' }, then: { parts: textParts('The follow-up finished.') } },
        { id: 'fork', priority: 100, when: { latestUserTextIncludes: 'fork-marker' }, then: { parts: textParts('Fork job done.') } },
        { id: 'slow-job', priority: 100, when: { latestUserTextIncludes: 'slow-job-marker' }, then: { parts: textParts('Slow job done.'), defaultPartDelayMs: 500 } },
        { id: 'woken-by-slow-job', priority: 330, when: { latestUserTextRegex: '<session-finished[\\s\\S]*Slow job done' }, then: { parts: textParts('The slow job finished.') } },
        { id: 'woken-by-fork', priority: 310, when: { latestUserTextIncludes: '<session-finished', rawPromptIncludes: 'Fork job done.' }, then: { parts: textParts('The fork finished the job.') } },
        { id: 'btw', priority: 100, when: { latestUserTextIncludes: 'btw-marker' }, then: { parts: textParts('Side answer.') } },
        { id: 'side', priority: 100, when: { latestUserTextIncludes: 'side-marker' }, then: { parts: textParts('Side check done.') } },
        // The silent note of the side thread is in the history only when it arrived.
        { id: 'recap-seen', priority: 200, when: { latestUserTextIncludes: 'recap-marker', rawPromptIncludes: 'Side check done.' }, then: { parts: textParts('A side thread finished meanwhile.') } },
        { id: 'recap-unseen', priority: 150, when: { latestUserTextIncludes: 'recap-marker' }, then: { parts: textParts('Nothing new.') } },
        { id: 'woken', priority: 300, when: { latestUserTextIncludes: '<session-finished' }, then: { parts: textParts('The worker finished the job.') } },
        { id: 'stale-wake', priority: 350, when: { latestUserTextIncludes: 'stale-wake-marker' }, then: { parts: textParts('Woke on the stale role text.') } },
      ],
  })
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, coordinator: true })
}, 60_000)

// Role texts the kimaki plugin stored in a session (plugin/coordinator.ts), oldest first.
async function roleTexts(sessionID: string): Promise<string[]> {
  const client = await server.client()
  const messages = await client.message.list({ sessionID, order: 'desc', limit: 100 })
  return [...messages.data].reverse().flatMap((message) => (message.type === 'synthetic' && message.text.includes('<kimaki-coordinator>') ? [message.text] : []))
}

// Token counts and run times differ between runs.
function usageless(note: string): string {
  return note.replace(/ context="[^"]+"/, ' context="N tokens"').replace(/ duration="[^"]+"/, ' duration="Ns"')
}

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('channel messages go to one session that replies in the channel', async () => {
  const { discord, channelId } = twin
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Say hi hello-marker' })
  await waitForFooter({ discord, threadId: channelId })
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Again hello-marker once-marker' })
  await waitForFooter({ discord, threadId: channelId, count: 2 })

  expect(await discord.channel(channelId).text({ showReplies: true })).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Say hi hello-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# Coordinator mode is on: this channel is one session that starts and manages project threads for you. Use /new-session for a thread without it. Turn it off with /toggle-coordinator or start kimaki with \`--coordinator false\`.
    [reply to tommy: Say hi hello-marker]
    Hello from the coordinator.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Again hello-marker once-marker
    --- from: assistant (TestBot)
    [reply to tommy: Again hello-marker once-marker]
    Hello from the coordinator.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(await discord.channel(channelId).getThreads()).toHaveLength(0)
  // The role text reaches the model once per request, also when the plugin checks the request.
  const request = server.model.requests.findLast((item) => item.latestUserText.includes('once-marker'))
  expect(request?.raw.split('## coordinator: you coordinate').length).toBe(2)
  // The coordinator role comes from the plugin, once: not from the frozen instructions entry.
  const root = bot.store.getState().roots[channelId]!
  const roles = await roleTexts(root)
  expect(roles).toHaveLength(1)
  expect(roles[0]).toContain('## coordinator: you coordinate this channel')
  expect(roles[0]).toContain(`--parent-session ${root}`)
  const entries = await (await server.client()).session.instructions.entry.list({ sessionID: root })
  expect(JSON.stringify(entries)).not.toContain('## coordinator')
})

test('a worker started with --parent-session gets a thread and wakes the coordinator when done', async () => {
  const { discord, channelId } = twin
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter)
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Fix it delegate-marker' })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000 })
  await waitForFooter({ discord, threadId: thread.id })
  await waitFor({
    label: 'woken reply',
    check: async () => (await discord.channel(channelId).text()).includes('The worker finished the job.') || null,
  })
  // The dispatch turn answered IDLE after its tool line: only the woken report gets a footer.
  await waitForFooter({ discord, threadId: channelId, count: footers.length + 1 })

  // Only the first answer text of a user prompt replies to it: never tool lines, the wake answer or a worker thread.
  expect((await discord.channel(channelId).text({ showReplies: true })).replaceAll(thread.id, 'worker-thread')).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Say hi hello-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# Coordinator mode is on: this channel is one session that starts and manages project threads for you. Use /new-session for a thread without it. Turn it off with /toggle-coordinator or start kimaki with \`--coordinator false\`.
    [reply to tommy: Say hi hello-marker]
    Hello from the coordinator.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Again hello-marker once-marker
    --- from: assistant (TestBot)
    [reply to tommy: Again hello-marker once-marker]
    Hello from the coordinator.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Fix it delegate-marker
    --- from: assistant (TestBot)
    -# ┣ shell _Start the worker thread_
    The worker finished the job.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(await discord.thread(thread.id).text({ showReplies: true })).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# » **CLI:** worker-marker do the job
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Job done in the worker.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(thread.name).toBe('Worker task')
  const workerRoles = await roleTexts(bot.store.getState().roots[thread.id]!)
  expect(workerRoles).toHaveLength(1)
  expect(workerRoles[0]).toContain(`## worker of a coordinator`)
  expect(workerRoles[0]).toContain(`kimaki session read ${channelId}`)
})

test('a btw fork of a worker sent with --parent-session wakes the coordinator when done', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]!
  const worker = (await discord.channel(channelId).getThreads()).find((candidate) => candidate.name === 'Worker task')
  if (!worker) throw new Error('no Worker task thread')
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter).length
  // What the coordinator runs: kimaki send --thread <worker> --prompt '... btw' --parent-session <coordinator>
  const forked = await send(bot, { threadId: worker.id, prompt: 'fork-marker related job. btw', parentSessionId: root, senderSessionId: root })
  if (forked instanceof Error) throw forked
  await waitForFooter({ discord, threadId: forked.threadId })
  await waitForFooter({ discord, threadId: channelId, count: footers + 1 })

  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('The worker finished the job.'))).toMatchInlineSnapshot(`
    "The worker finished the job.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    The fork finished the job.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const fork = await (await server.client()).session.get({ sessionID: forked.sessionId! })
  expect(Reflect.get(Object(fork.metadata?.['kimaki']), 'parentSessionId')).toBe(root)
  expect((await roleTexts(fork.id)).at(-1)).toContain('## worker of a coordinator')
})

test('session read lists the Discord URL of a file a worker uploaded; its note does not', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]!
  fs.writeFileSync(path.join(server.projectDirectory, 'shot.png'), 'png')
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter).length
  const started = await send(bot, { channelId, name: 'Screenshot task', prompt: 'upload-marker take a screenshot', parentSessionId: root, senderSessionId: root })
  if (started instanceof Error) throw started
  await waitForFooter({ discord, threadId: started.threadId })
  await waitForFooter({ discord, threadId: channelId, count: footers + 1 })

  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('-# *main', text.lastIndexOf('-# *main') - 1))).toMatchInlineSnapshot(`
    "-# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    Here is the screenshot.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const client = await server.client()
  const messages = await client.message.list({ sessionID: root, order: 'desc', limit: 10 })
  const note = messages.data.find((message) => message.type === 'synthetic' && message.text.includes('Screenshot task'))
  expect(note?.type === 'synthetic' && usageless(note.text.replaceAll(started.sessionId!, 'ses_worker').replaceAll(started.threadId, 'worker-thread'))).toMatchInlineSnapshot(`
    "<session-finished sessionID="ses_worker" threadID="worker-thread" state="completed" title="Screenshot task" context="N tokens" duration="Ns" wake="true">
    Took the screenshot.
    More: kimaki session read ses_worker
    The user sees nothing else about this. When it is work they asked for, a failure or a decision they must make, tell them the outcome in a few plain sentences, with the thread link <#worker-thread> once. Otherwise reply exactly IDLE.
    </session-finished>"
  `)
  const read = await readSessionMarkdown({ client, sessionId: started.sessionId! })
  expect(read instanceof Error ? read : read.slice(read.indexOf('Took the screenshot.'), read.indexOf('Only prompts'))).toMatchInlineSnapshot(`
    "Took the screenshot.

    Media uploaded to Discord:
    - data:application/octet-stream;base64,cG5n

    "
  `)
  // --full and transcripts hide tool outputs but keep the uploaded media on the tool line.
  const full = await readSessionMarkdown({ client, sessionId: started.sessionId!, full: true, thinking: true })
  expect(full instanceof Error ? full : full.slice(full.indexOf('tool shell'), full.indexOf('finish: tool-calls')).trim()).toMatchInlineSnapshot(`
    "tool shell [completed] {"command":"kimaki upload-to-discord shot.png","description":"Upload the screenshot","hasSideEffect":true}
    Media uploaded to Discord:
    - data:application/octet-stream;base64,cG5n"
  `)
})

test('a run the user prompts in a worker thread is a silent note; a follow-up the coordinator sends wakes it', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]!
  const client = await server.client()
  const worker = (await discord.channel(channelId).getThreads()).find((candidate) => candidate.name === 'Worker task')
  if (!worker) throw new Error('no Worker task thread')
  const footers = () => discord.channel(channelId).getMessages().then((messages) => messages.filter(isFooter).length)
  const before = await footers()
  const workerFooters = (await discord.thread(worker.id).getMessages()).filter(isFooter).length
  await discord.thread(worker.id).user(TEST_USER_ID).sendMessage({ content: 'Also check the logs user-steer-marker' })
  await waitForFooter({ discord, threadId: worker.id, count: workerFooters + 1 })
  const note = await waitFor({
    label: 'silent note of the steered run',
    check: async () => {
      const inbox = await client.session.inbox.list({ sessionID: root })
      const item = inbox.find((candidate) => candidate.type === 'synthetic' && candidate.payload.text.includes('Steered job done.'))
      return item?.type === 'synthetic' ? item.payload.text : null
    },
  })
  expect(usageless(note.replaceAll(worker.id, 'worker-thread').replace(/ses_\w+/g, 'ses_worker'))).toMatchInlineSnapshot(`
    "<session-finished sessionID="ses_worker" threadID="worker-thread" state="completed" title="Worker task" context="N tokens" duration="Ns" wake="false">
    <user-prompt username="tommy">
    Also check the logs user-steer-marker
    </user-prompt>
    Steered job done.
    More: kimaki session read ses_worker
    </session-finished>"
  `)
  // Not woken: no new footer in the channel.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await footers()).toBe(before)
  }

  // What the coordinator runs: kimaki send --thread <worker> --prompt '...', from its own shell.
  const followed = await send(bot, { threadId: worker.id, prompt: 'Now the follow-up-marker', senderSessionId: root })
  if (followed instanceof Error) throw followed
  await waitForFooter({ discord, threadId: channelId, count: before + 1 })
  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('-# *main', text.lastIndexOf('-# *main') - 1))).toMatchInlineSnapshot(`
    "-# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    The follow-up finished.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a worker started with --wait answers through the wait, with no note', async () => {
  const { discord, channelId } = twin
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter)
  const threads = (await discord.channel(channelId).getThreads()).length
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Fix it waitjob-marker' })
  await waitForFooter({ discord, threadId: channelId, count: footers.length + 1 })
  const thread = (await discord.channel(channelId).getThreads()).find((candidate) => candidate.name === 'Waited task')
  if (!thread) throw new Error('no Waited task thread')
  await waitForFooter({ discord, threadId: thread.id })
  const root = bot.store.getState().roots[channelId]!
  const client = await server.client()
  // No note arrives: not in the inbox, no wake, no "finished" line.
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    const inbox = await client.session.inbox.list({ sessionID: root })
    expect(inbox.filter((item) => item.type === 'synthetic' && item.payload.text.includes('Waited task'))).toHaveLength(0)
  }

  const text = (await discord.channel(channelId).text()).replaceAll(thread.id, 'worker-thread')
  // The answer of the busy prompt, then the queued one starts: its IDLE answer posts nothing.
  expect(text.slice(text.lastIndexOf('[reply to tommy: Take a while'))).toMatchInlineSnapshot(`"*"`)
  expect(await discord.channel(channelId).getThreads()).toHaveLength(threads + 1)
  const messages = await client.message.list({ sessionID: root, order: 'desc', limit: 20 })
  expect(messages.data.some((message) => message.type === 'synthetic' && JSON.stringify(message).includes('Waited task'))).toBe(false)
})

test('a worker that outlives a bounded --wait wakes the coordinator with a note', async () => {
  const { discord, channelId } = twin
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter)
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Do it boundedwait-marker' })
  await waitForFooter({ discord, threadId: channelId, count: footers.length + 1 })
  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('Do it boundedwait-marker'))).toMatchInlineSnapshot(`
    "Do it boundedwait-marker
    --- from: assistant (TestBot)
    -# ┣ shell _Start the worker, wait briefly_
    The bounded job finished.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(server.model.requests.some((request) => request.raw.includes('is still running after 0.1s'))).toBe(true)
})

test('another thread of the channel leaves a silent note for the next prompt', async () => {
  const { discord, channelId } = twin
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter)
  const started = await send(bot, { channelId, prompt: 'side-marker check something' })
  if (started instanceof Error) throw started
  await waitForFooter({ discord, threadId: started.threadId })
  const client = await server.client()
  const root = bot.store.getState().roots[channelId]!
  await waitFor({
    label: 'silent note in the coordinator',
    check: async () => {
      // Not delivered yet: a note without wake waits in the inbox for the next run.
      const inbox = await client.session.inbox.list({ sessionID: root })
      return inbox.some((item) => item.type === 'synthetic' && item.payload.text.includes('wake="false"')) || null
    },
  })
  // Not woken: no new footer in the channel until the user writes.
  expect((await discord.channel(channelId).getMessages()).filter(isFooter)).toHaveLength(footers.length)
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'What happened? recap-marker' })
  await waitForFooter({ discord, threadId: channelId, count: footers.length + 1 })

  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('--- from: user'))).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    What happened? recap-marker
    --- from: assistant (TestBot)
    A side thread finished meanwhile.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a btw fork of the coordinator is a worker: no coordinator timers', async () => {
  const { discord, channelId } = twin
  const before = (await discord.channel(channelId).getThreads()).length
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Why that choice btw-marker. btw' })
  const thread = await waitFor({
    label: 'btw thread',
    check: async () => (await discord.channel(channelId).getThreads()).slice(before).find((candidate) => candidate.name?.startsWith('btw:')) ?? null,
  })
  await waitForFooter({ discord, threadId: thread.id })
  const client = await server.client()
  const fork = await client.session.get({ sessionID: bot.store.getState().roots[thread.id]! })
  expect(Reflect.get(Object(fork.metadata?.['kimaki']), 'coordinator')).toBeUndefined()
  // The fork copied the coordinator role; its own worker role comes after it.
  const roles = await roleTexts(fork.id)
  expect(roles.map((text) => (text.includes('## worker of a coordinator') ? 'worker' : 'coordinator'))).toEqual(['coordinator', 'worker'])
})

test('a stale coordinator role text is replaced: on a wake for that request, then stored at the next prompt', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]!
  const client = await server.client()
  const current = (await roleTexts(root)).at(-1)!
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter).length
  // Like a role text of older plugin code, as the latest one in the history, waking the session.
  await client.session.synthetic({ sessionID: root, text: '<system-reminder>\n<kimaki-coordinator>\nold role text stale-wake-marker\n</kimaki-coordinator>\n</system-reminder>' })
  await waitForFooter({ discord, threadId: channelId, count: footers + 1 })
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Again hello-marker' })
  await waitForFooter({ discord, threadId: channelId, count: footers + 2 })

  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('Session forked!')).replace(/<#\d+>/, '<#btw-thread>')).toMatchInlineSnapshot(`
    "Session forked! Continue in <#btw-thread>
    Woke on the stale role text.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Again hello-marker
    --- from: assistant (TestBot)
    Hello from the coordinator.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  // The wake request already had the current role text after the stale one.
  const wake = server.model.requests.findLast((item) => item.latestUserText.includes('stale-wake-marker'))
  expect(wake?.latestUserText).toMatch(/stale-wake-marker[\s\S]*## coordinator: you coordinate this channel/)
  const roles = await roleTexts(root)
  expect(roles.at(-1)).toBe(current)
  expect(roles.at(-2)).toContain('stale-wake-marker')
})

test('the coordinator shows typing while a worker runs in the background', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]!
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter).length
  discord.channel(channelId).clearTypingEvents()
  const started = await send(bot, { channelId, name: 'Slow task', prompt: 'slow-job-marker take your time', parentSessionId: root, senderSessionId: root })
  if (started instanceof Error) throw started
  await discord.channel(channelId).waitForTypingEvent()
  // Read when typing starts: it must come from the running worker, not from the wake after it.
  const workerAtTyping = await discord.thread(started.threadId).text()
  await waitForFooter({ discord, threadId: started.threadId })
  await waitForFooter({ discord, threadId: channelId, count: footers + 1 })

  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('-# *main', text.lastIndexOf('-# *main') - 1))).toMatchInlineSnapshot(`
    "-# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    The slow job finished.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(workerAtTyping).not.toContain('-# *main')
})

test('/toggle-coordinator turns coordinator mode off and on per channel; the choice survives a restart', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]
  const toggle = async () => {
    const { id: interactionId } = await discord.channel(channelId).user(TEST_USER_ID).runSlashCommand({ name: 'toggle-coordinator' })
    await discord.channel(channelId).waitForInteractionAck({ interactionId, timeout: 4_000 })
  }
  await toggle()
  const threads = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Mode off hello-marker' })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (found) => !threads.has(found.id) })
  await waitForFooter({ discord, threadId: thread.id })
  expect(bot.store.getState().roots[channelId]).toBe(root)

  await toggle()
  // Started with coordinator mode off by default: the channel keeps its choice and its coordinator.
  await bot.stop()
  bot = await startTestBot({ dataDir, twin, server })
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter).length
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Mode on hello-marker' })
  await waitForFooter({ discord, threadId: channelId, count: footers + 1 })
  expect(bot.store.getState().roots[channelId]).toBe(root)

  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('Coordinator mode **off**'))).toMatchInlineSnapshot(`
    "Coordinator mode **off** for this channel. Each channel message starts a new thread.
    --- from: user (tommy)
    Mode off hello-marker
    --- from: assistant (TestBot)
    Coordinator mode **on** for this channel. Channel messages go to one long coordinator session that starts threads for the work. It continues the coordinator session this channel had before; /reset-coordinator starts a fresh one.
    --- from: user (tommy)
    Mode on hello-marker
    --- from: assistant (TestBot)
    Hello from the coordinator.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('the coordinator survives a bot restart; /reset-coordinator starts a fresh one', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]
  await bot.stop()
  bot = await startTestBot({ dataDir, twin, server, coordinator: true })
  expect(bot.store.getState().roots[channelId]).toBe(root)

  const { id: interactionId } = await discord.channel(channelId).user(TEST_USER_ID).runSlashCommand({ name: 'reset-coordinator' })
  await discord.channel(channelId).waitForInteractionAck({ interactionId, timeout: 4_000 })
  expect(bot.store.getState().roots[channelId]).toBeUndefined()
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter).length
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Fresh start hello-marker' })
  await waitForFooter({ discord, threadId: channelId, count: footers + 1 })

  const fresh = bot.store.getState().roots[channelId]
  expect(fresh && fresh !== root).toBe(true)
  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('--- from: user'))).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Fresh start hello-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# Coordinator mode is on: this channel is one session that starts and manages project threads for you. Use /new-session for a thread without it. Turn it off with /toggle-coordinator or start kimaki with \`--coordinator false\`.
    Hello from the coordinator.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
