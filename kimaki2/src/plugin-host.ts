// Promise-surface copy of OpenCode v2 packages/core/test/plugin/host.ts.
// Full Plugin.Context. Unused methods throw. Override session, event, storage per test.

import { Location, Plugin } from '@opencode-ai/plugin'
import type { SessionPrompt } from '@opencode-ai/plugin/promise/session'

type Overrides = Partial<Omit<Plugin.Context, 'options' | 'session'>> & {
  readonly session?: Partial<Plugin.Context['session']>
}

function unused(name: string) {
  return () => {
    throw new Error(`unused ${name}`)
  }
}

function unusedAsync(name: string) {
  return async () => {
    throw new Error(`unused ${name}`)
  }
}

function defaultLocation(directory = '/workspace'): Location.Info {
  return new Location.Info({
    directory: directory as Location.Info['directory'],
    project: {
      id: 'global' as Location.Info['project']['id'],
      directory: directory as Location.Info['directory'],
      canonical: directory as Location.Info['directory'],
    },
  })
}

export function host(overrides: Overrides = {}): Plugin.Context {
  const defaults = {
    app: { name: 'test', version: 'test', channel: 'test' },
    location: defaultLocation(),
    options: {},
    rpc: Object.assign(unused('rpc.client'), { register: unusedAsync('rpc.register') }),
    agent: {
      get: unusedAsync('agent.get'),
      list: unusedAsync('agent.list'),
      transform: unusedAsync('agent.transform'),
      reload: unusedAsync('agent.reload'),
    },
    aisdk: {
      hook: unusedAsync('aisdk.hook'),
    },
    catalog: {
      provider: {
        list: unusedAsync('catalog.provider.list'),
        get: unusedAsync('catalog.provider.get'),
      },
      model: {
        list: unusedAsync('catalog.model.list'),
        default: unusedAsync('catalog.model.default'),
      },
      transform: unusedAsync('catalog.transform'),
      reload: unusedAsync('catalog.reload'),
    },
    command: {
      list: unusedAsync('command.list'),
      transform: unusedAsync('command.transform'),
      reload: unusedAsync('command.reload'),
    },
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {},
      }),
    },
    experimental: {
      terminal: {
        read: unusedAsync('experimental.terminal.read'),
      },
    },
    generate: {
      text: unusedAsync('generate.text'),
    },
    integration: {
      list: unusedAsync('integration.list'),
      get: unusedAsync('integration.get'),
      connect: {
        key: unusedAsync('integration.connect.key'),
      },
      oauth: {
        connect: unusedAsync('integration.oauth.connect'),
        status: unusedAsync('integration.oauth.status'),
        complete: unusedAsync('integration.oauth.complete'),
        cancel: unusedAsync('integration.oauth.cancel'),
      },
      command: {
        connect: unusedAsync('integration.command.connect'),
        status: unusedAsync('integration.command.status'),
        cancel: unusedAsync('integration.command.cancel'),
      },
      transform: unusedAsync('integration.transform'),
      reload: unusedAsync('integration.reload'),
      connection: {
        active: unusedAsync('integration.connection.active'),
        resolve: unusedAsync('integration.connection.resolve'),
      },
    },
    mcp: {
      list: unusedAsync('mcp.list'),
      transform: unusedAsync('mcp.transform'),
      reload: unusedAsync('mcp.reload'),
    },
    permission: {
      hook: unusedAsync('permission.hook'),
      list: unusedAsync('permission.list'),
      get: unusedAsync('permission.get'),
      reply: unusedAsync('permission.reply'),
    },
    plugin: {
      list: unusedAsync('plugin.list'),
    },
    reference: {
      list: unusedAsync('reference.list'),
      transform: unusedAsync('reference.transform'),
      reload: unusedAsync('reference.reload'),
    },
    skill: {
      list: unusedAsync('skill.list'),
      transform: unusedAsync('skill.transform'),
      reload: unusedAsync('skill.reload'),
    },
    storage: {
      get: unusedAsync('storage.get'),
      set: unusedAsync('storage.set'),
      remove: unusedAsync('storage.remove'),
      scan: unusedAsync('storage.scan'),
    },
    shell: {
      hook: unusedAsync('shell.hook'),
    },
    tool: {
      transform: unusedAsync('tool.transform'),
      reload: unusedAsync('tool.reload'),
      hook: unusedAsync('tool.hook'),
    },
    vcs: {
      base: unusedAsync('vcs.base'),
      get: unusedAsync('vcs.get'),
      branches: unusedAsync('vcs.branches'),
      status: unusedAsync('vcs.status'),
      diff: unusedAsync('vcs.diff'),
      transform: unusedAsync('vcs.transform'),
      reload: unusedAsync('vcs.reload'),
    },
    websearch: {
      providers: unusedAsync('websearch.providers'),
      query: unusedAsync('websearch.query'),
      transform: unusedAsync('websearch.transform'),
      reload: unusedAsync('websearch.reload'),
    },
    worktree: {
      create: unusedAsync('worktree.create'),
      list: unusedAsync('worktree.list'),
      refresh: unusedAsync('worktree.refresh'),
      remove: unusedAsync('worktree.remove'),
      transform: unusedAsync('worktree.transform'),
      reload: unusedAsync('worktree.reload'),
    },
    session: {
      hook: unusedAsync('session.hook'),
      create: unusedAsync('session.create'),
      get: unusedAsync('session.get'),
      switchAgent: unusedAsync('session.switchAgent'),
      switchModel: unusedAsync('session.switchModel'),
      prompt: unusedAsync('session.prompt'),
      generate: unusedAsync('session.generate'),
      command: unusedAsync('session.command'),
      rename: unusedAsync('session.rename'),
      move: unusedAsync('session.move'),
      synthetic: unusedAsync('session.synthetic'),
      interrupt: unusedAsync('session.interrupt'),
      wait: unusedAsync('session.wait'),
      context: unusedAsync('session.context'),
    },
  } satisfies Plugin.Context

  return {
    ...defaults,
    ...overrides,
    options: {},
    session: {
      ...defaults.session,
      ...overrides.session,
    },
  }
}

export function memoryStorage(): Plugin.Context['storage'] {
  const map = new Map<string, Parameters<Plugin.Context['storage']['set']>[1]>()
  return {
    async get(key) {
      return map.get(key)
    },
    async set(key, value) {
      map.set(key, value)
    },
    async remove(key) {
      map.delete(key)
    },
    async scan(options) {
      const entries = [...map.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value }))
      return { entries }
    },
  }
}

export function createBus() {
  const listeners = new Set<(event: unknown) => void>()
  return {
    publish(event: unknown) {
      for (const listener of listeners) listener(event)
    },
    subscribe(): AsyncIterable<unknown> {
      const queue: unknown[] = []
      let notify: (() => void) | undefined
      const listener = (event: unknown) => {
        queue.push(event)
        notify?.()
      }
      listeners.add(listener)
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              while (queue.length === 0) {
                await new Promise<void>((resolve) => {
                  notify = resolve
                })
              }
              yield queue.shift()
            }
          } finally {
            listeners.delete(listener)
          }
        },
      }
    },
  }
}

export async function activatePlugin({
  plugin,
  ctx,
}: {
  plugin: Plugin.Plugin
  ctx: Plugin.Context
}) {
  const cleanup = await plugin.setup(ctx)
  return {
    async dispose() {
      await cleanup?.()
    },
  }
}

export function promptEvent({
  sessionID = 'ses_test',
  text = 'hello',
  delivery = 'steer' as const,
}: {
  sessionID?: string
  text?: string
  delivery?: 'steer' | 'queue'
} = {}): SessionPrompt {
  return {
    sessionID: sessionID as SessionPrompt['sessionID'],
    messageID: 'msg_test' as SessionPrompt['messageID'],
    prompt: { text },
    delivery,
  }
}
