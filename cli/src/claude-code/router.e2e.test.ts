// Hermetic end-to-end test for the Claude Code backend router.
//
// Uses the REAL @opencode-ai/sdk/v2 client against the router (full wire
// protocol), a fake upstream opencode server, and a scriptable fake Agent SDK
// query implementation — no Claude subprocess, no network.

import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createOpencodeClient, type Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { setDataDir } from '../config.js'
import { startClaudeCodeRouter, type ClaudeCodeRouter } from './server.js'
import type { QueryImpl } from './sessions.js'

// ── Fake Agent SDK query ─────────────────────────────────────────

type FakeQueryContext = {
  options: Options
  nextInput: () => Promise<SDKUserMessage>
  emit: (message: SDKMessage) => void
  onInterrupt: (handler: () => void) => void
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    extra: { toolUseID: string },
  ) => Promise<PermissionResult | null>
}

type FakeScript = (ctx: FakeQueryContext) => Promise<void>

function createFakeQueryImpl(script: FakeScript): QueryImpl {
  const impl = ({
    prompt,
    options,
  }: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options?: Options
  }): Query => {
    const output: SDKMessage[] = []
    let outputNotify: (() => void) | null = null
    let scriptDone = false
    let interruptHandler: (() => void) | null = null

    const inputIterator = typeof prompt === 'string' ? null : prompt[Symbol.asyncIterator]()

    const ctx: FakeQueryContext = {
      options: options ?? {},
      nextInput: async () => {
        if (!inputIterator) {
          throw new Error('fake query requires streaming input')
        }
        const result = await inputIterator.next()
        if (result.done) {
          throw new Error('input ended')
        }
        return result.value
      },
      emit: (message) => {
        output.push(message)
        outputNotify?.()
        outputNotify = null
      },
      onInterrupt: (handler) => {
        interruptHandler = handler
      },
      canUseTool: async (toolName, input, extra) => {
        const handler = options?.canUseTool
        if (!handler) {
          return { behavior: 'allow', updatedInput: input }
        }
        const abortController = new AbortController()
        return handler(toolName, input, {
          signal: abortController.signal,
          toolUseID: extra.toolUseID,
          requestId: `req_${extra.toolUseID}`,
        })
      },
    }

    void script(ctx)
      .catch(() => {
        // input ended or script error — just finish the stream
      })
      .finally(() => {
        scriptDone = true
        outputNotify?.()
        outputNotify = null
      })

    const generator = (async function* () {
      while (true) {
        const message = output.shift()
        if (message) {
          yield message
          continue
        }
        if (scriptDone) {
          return
        }
        await new Promise<void>((resolve) => {
          outputNotify = resolve
        })
      }
    })()

    const fakeQuery = {
      next: generator.next.bind(generator),
      return: generator.return.bind(generator),
      throw: generator.throw.bind(generator),
      [Symbol.asyncIterator]() {
        return this
      },
      [Symbol.asyncDispose]: async () => {},
      interrupt: async () => {
        interruptHandler?.()
      },
      close: () => {},
      setModel: async () => {},
      supportedCommands: async () => {
        return []
      },
      supportedModels: async () => {
        return []
      },
      rewindFiles: async () => {
        return { canRewind: true }
      },
      streamInput: async () => {},
    }
    // The Query interface carries ~25 control methods; the fake implements the
    // subset the backend uses and is bridged through unknown for the rest.
    return fakeQuery as unknown as Query
  }
  return impl as QueryImpl
}

// ── Fake upstream opencode server ────────────────────────────────

async function startFakeUpstream(): Promise<{ baseUrl: string; close: () => void }> {
  const openStreams = new Set<http.ServerResponse>()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const respond = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/global/event') {
      // Never-ending SSE stream like the real opencode server.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(':connected\n\n')
      openStreams.add(res)
      req.on('close', () => {
        openStreams.delete(res)
      })
      return
    }
    if (url.pathname === '/provider') {
      respond({
        all: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            source: 'api',
            env: [],
            options: {},
            models: {},
          },
        ],
        default: { anthropic: 'claude-something' },
        connected: ['anthropic'],
      })
      return
    }
    if (url.pathname === '/session/status') {
      respond({ ses_upstream_1: { type: 'idle' } })
      return
    }
    if (url.pathname === '/session' && req.method === 'GET') {
      respond([])
      return
    }
    if (url.pathname === '/session' && req.method === 'POST') {
      respond({
        id: 'ses_upstream_new',
        slug: 'upstream',
        projectID: 'p',
        directory: '/tmp',
        title: 'upstream session',
        version: '1',
        time: { created: Date.now(), updated: Date.now() },
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: `no fake for ${req.method} ${url.pathname}` }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('fake upstream failed to bind')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => {
      for (const stream of openStreams) {
        stream.end()
      }
      server.close()
    },
  }
}

// ── Scripts for each scenario, selected per session directory ────

const scriptsByDirectory = new Map<string, FakeScript>()

const dispatcherScript: FakeScript = async (ctx) => {
  const directory = ctx.options.cwd ?? ''
  const script = scriptsByDirectory.get(directory)
  if (!script) {
    throw new Error(`no fake script for directory ${directory}`)
  }
  await script(ctx)
}

function fakeInit(ctx: FakeQueryContext): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '2.0.0',
    cwd: ctx.options.cwd ?? '/tmp',
    tools: ['Bash', 'Edit'],
    mcp_servers: [],
    model: 'claude-opus-4-8',
    permissionMode: 'default',
    slash_commands: ['compact', 'review'],
    output_style: 'default',
    skills: [],
    plugins: [],
    agents: ['general-purpose'],
    uuid: crypto.randomUUID(),
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001',
  } as SDKMessage
}

function fakeAssistantText(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_api_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001',
  } as SDKMessage
}

function fakeResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001',
  } as SDKMessage
}

// ── Test wiring ──────────────────────────────────────────────────

let router: ClaudeCodeRouter
let upstream: Awaited<ReturnType<typeof startFakeUpstream>>
let collectedEvents: Array<{ directory: string; payload: OpenCodeEvent }> = []
let eventAbort: AbortController

function makeClient({ claudeBackend }: { claudeBackend: boolean }) {
  return createOpencodeClient({
    baseUrl: router.baseUrl,
    ...(claudeBackend ? { headers: { 'x-kimaki-backend': 'claude-code' } } : {}),
  })
}

async function waitForEvent(
  predicate: (event: OpenCodeEvent) => boolean,
  timeoutMs = 5000,
): Promise<OpenCodeEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = collectedEvents.find(({ payload }) => {
      return predicate(payload)
    })
    if (found) {
      return found.payload
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
  }
  throw new Error(
    `Timed out waiting for event. Collected: ${collectedEvents
      .map(({ payload }) => {
        return payload.type
      })
      .join(', ')}`,
  )
}

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-claude-test-'))
  setDataDir(dataDir)
  upstream = await startFakeUpstream()
  router = await startClaudeCodeRouter({
    getUpstreamBaseUrl: () => {
      return upstream.baseUrl
    },
    queryImpl: createFakeQueryImpl(dispatcherScript),
  })

  // Collect merged global events through the real SDK client.
  eventAbort = new AbortController()
  const client = makeClient({ claudeBackend: false })
  const subscription = await client.global.event({ signal: eventAbort.signal })
  void (async () => {
    for await (const event of subscription.stream) {
      collectedEvents.push(event as { directory: string; payload: OpenCodeEvent })
    }
  })().catch(() => {
    // aborted at teardown
  })
})

afterAll(async () => {
  eventAbort?.abort()
  await router?.close()
  upstream?.close()
})

describe('claude-code router', () => {
  test('creates sessions on the claude backend only with the header', async () => {
    const claudeClient = makeClient({ claudeBackend: true })
    const created = await claudeClient.session.create({ directory: '/tmp/proj-basic' })
    expect(created.data?.id).toMatch(/^ses_claude_/)

    const plainClient = makeClient({ claudeBackend: false })
    const upstreamCreated = await plainClient.session.create({ directory: '/tmp/other' })
    expect(upstreamCreated.data?.id).toBe('ses_upstream_new')
  })

  test('prompt flows through the fake agent and emits opencode events', async () => {
    const directory = '/tmp/proj-basic'
    scriptsByDirectory.set(directory, async (ctx) => {
      await ctx.nextInput()
      ctx.emit(fakeInit(ctx))
      ctx.emit(fakeAssistantText('Hello from Claude Code'))
      ctx.emit(fakeResult())
      // Stay alive for a potential follow-up prompt.
      await ctx.nextInput().catch(() => {
        return undefined
      })
    })

    const client = makeClient({ claudeBackend: true })
    const created = await client.session.create({ directory })
    const sessionId = created.data!.id

    const promptResponse = await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      parts: [{ type: 'text', text: 'hi there' }],
    })
    expect(promptResponse.error).toBeFalsy()

    await waitForEvent((event) => {
      return (
        event.type === 'session.status' &&
        event.properties.sessionID === sessionId &&
        event.properties.status.type === 'busy'
      )
    })
    await waitForEvent((event) => {
      return (
        event.type === 'message.part.updated' &&
        event.properties.sessionID === sessionId &&
        event.properties.part.type === 'text' &&
        event.properties.part.text.includes('Hello from Claude Code')
      )
    })
    await waitForEvent((event) => {
      return event.type === 'session.idle' && event.properties.sessionID === sessionId
    })

    const messages = await client.session.messages({ sessionID: sessionId, directory })
    expect(messages.data).toBeTruthy()
    const roles = messages.data!.map(({ info }) => {
      return info.role
    })
    expect(roles).toEqual(['user', 'assistant'])
    const assistant = messages.data![1]!
    expect(assistant.info.role).toBe('assistant')
    if (assistant.info.role === 'assistant') {
      expect(assistant.info.cost).toBeCloseTo(0.0123)
      expect(assistant.info.time.completed).toBeTruthy()
    }

    const statuses = await client.session.status({ directory })
    expect(statuses.data?.[sessionId]).toEqual({ type: 'idle' })
    // Upstream statuses are merged in.
    expect(statuses.data?.ses_upstream_1).toEqual({ type: 'idle' })
  })

  test('permission ask → discord reply → allow, and always persists a rule', async () => {
    const directory = '/tmp/proj-perms'
    const permissionResults: Array<PermissionResult | null> = []
    scriptsByDirectory.set(directory, async (ctx) => {
      await ctx.nextInput()
      ctx.emit(fakeInit(ctx))
      const first = await ctx.canUseTool(
        'Bash',
        { command: 'git push origin main' },
        { toolUseID: 'toolu_perm_1' },
      )
      permissionResults.push(first)
      ctx.emit(fakeResult())
      await ctx.nextInput()
      const second = await ctx.canUseTool(
        'Bash',
        { command: 'git status' },
        { toolUseID: 'toolu_perm_2' },
      )
      permissionResults.push(second)
      ctx.emit(fakeResult())
      await ctx.nextInput().catch(() => {
        return undefined
      })
    })

    const client = makeClient({ claudeBackend: true })
    const created = await client.session.create({ directory })
    const sessionId = created.data!.id

    await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      parts: [{ type: 'text', text: 'push my changes' }],
    })

    const asked = await waitForEvent((event) => {
      return event.type === 'permission.asked' && event.properties.sessionID === sessionId
    })
    if (asked.type !== 'permission.asked') {
      throw new Error('unreachable')
    }
    expect(asked.properties.permission).toBe('bash')
    expect(asked.properties.patterns).toEqual(['git push origin main'])
    expect(asked.properties.always).toEqual(['git *'])

    const replyResponse = await client.permission.reply({
      requestID: asked.properties.id,
      directory,
      reply: 'always',
    })
    expect(replyResponse.data).toBe(true)

    await waitForEvent((event) => {
      return (
        event.type === 'permission.replied' && event.properties.requestID === asked.properties.id
      )
    })

    // Second bash command matches the persisted `git *` rule → auto-allowed
    // without a new permission.asked event.
    await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      parts: [{ type: 'text', text: 'now check status' }],
    })
    await waitForEvent((event) => {
      return event.type === 'session.idle' && event.properties.sessionID === sessionId
    })
    const askedEvents = collectedEvents.filter(({ payload }) => {
      return payload.type === 'permission.asked' && payload.properties.sessionID === sessionId
    })
    expect(askedEvents).toHaveLength(1)
    expect(permissionResults[0]).toMatchObject({ behavior: 'allow' })
    expect(permissionResults[1]).toMatchObject({ behavior: 'allow' })
  })

  test('AskUserQuestion becomes question.asked and answers flow back', async () => {
    const directory = '/tmp/proj-question'
    const questionResults: Array<PermissionResult | null> = []
    scriptsByDirectory.set(directory, async (ctx) => {
      await ctx.nextInput()
      ctx.emit(fakeInit(ctx))
      const result = await ctx.canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question: 'Which framework?',
              header: 'Framework',
              multiSelect: false,
              options: [
                { label: 'React', description: 'UI library' },
                { label: 'Vue', description: 'Framework' },
              ],
            },
          ],
        },
        { toolUseID: 'toolu_q_1' },
      )
      questionResults.push(result)
      ctx.emit(fakeResult())
      await ctx.nextInput().catch(() => {
        return undefined
      })
    })

    const client = makeClient({ claudeBackend: true })
    const created = await client.session.create({ directory })
    const sessionId = created.data!.id

    await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      parts: [{ type: 'text', text: 'set up a frontend' }],
    })

    const asked = await waitForEvent((event) => {
      return event.type === 'question.asked' && event.properties.sessionID === sessionId
    })
    if (asked.type !== 'question.asked') {
      throw new Error('unreachable')
    }
    expect(asked.properties.questions[0]).toMatchObject({
      question: 'Which framework?',
      header: 'Framework',
    })

    const replyResponse = await client.question.reply({
      requestID: asked.properties.id,
      directory,
      answers: [['React']],
    })
    expect(replyResponse.data).toBe(true)

    await waitForEvent((event) => {
      return event.type === 'question.replied' && event.properties.requestID === asked.properties.id
    })

    const result = questionResults[0]
    expect(result).toBeTruthy()
    if (result && result.behavior === 'allow') {
      expect(result.updatedInput).toMatchObject({
        answers: { 'Which framework?': 'React' },
      })
    } else {
      throw new Error(`expected allow, got ${JSON.stringify(result)}`)
    }
  })

  test('abort interrupts the live query and idles the session', async () => {
    const directory = '/tmp/proj-abort'
    let sawInterrupt = false
    scriptsByDirectory.set(directory, async (ctx) => {
      await ctx.nextInput()
      ctx.emit(fakeInit(ctx))
      // Simulate a long-running turn that only finishes when interrupted.
      await new Promise<void>((resolve) => {
        ctx.onInterrupt(() => {
          sawInterrupt = true
          resolve()
        })
      })
      ctx.emit({
        ...fakeResult(),
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['aborted'],
      } as SDKMessage)
      await ctx.nextInput().catch(() => {
        return undefined
      })
    })

    const client = makeClient({ claudeBackend: true })
    const created = await client.session.create({ directory })
    const sessionId = created.data!.id

    await client.session.promptAsync({
      sessionID: sessionId,
      directory,
      parts: [{ type: 'text', text: 'do something slow' }],
    })
    await waitForEvent((event) => {
      return (
        event.type === 'session.status' &&
        event.properties.sessionID === sessionId &&
        event.properties.status.type === 'busy'
      )
    })

    const abortResponse = await client.session.abort({ sessionID: sessionId, directory })
    expect(abortResponse.data).toBe(true)

    await waitForEvent((event) => {
      return event.type === 'session.idle' && event.properties.sessionID === sessionId
    })
    expect(sawInterrupt).toBe(true)
  })

  test('provider.list merges the claude-code provider with upstream', async () => {
    const client = makeClient({ claudeBackend: false })
    const providers = await client.provider.list({ directory: '/tmp/anything' })
    expect(providers.data).toBeTruthy()
    const ids = providers.data!.all.map((provider) => {
      return provider.id
    })
    expect(ids).toContain('anthropic')
    expect(ids).toContain('claude-code')
    expect(providers.data!.connected).toContain('claude-code')
    const claudeProvider = providers.data!.all.find((provider) => {
      return provider.id === 'claude-code'
    })
    expect(Object.keys(claudeProvider!.models).length).toBeGreaterThan(0)
    const opus = claudeProvider!.models['claude-opus-4-8']
    expect(opus?.variants).toMatchObject({ high: {}, max: {} })
  })

  test('session list merges claude sessions with upstream and session.get works', async () => {
    const client = makeClient({ claudeBackend: true })
    const created = await client.session.create({ directory: '/tmp/proj-list' })
    const sessionId = created.data!.id

    const list = await client.session.list({ directory: '/tmp/proj-list' })
    const listed = list.data!.find((session) => {
      return session.id === sessionId
    })
    expect(listed).toBeTruthy()

    const fetched = await client.session.get({ sessionID: sessionId })
    expect(fetched.data?.id).toBe(sessionId)
    expect(fetched.data?.directory).toBe('/tmp/proj-list')
  })
})
