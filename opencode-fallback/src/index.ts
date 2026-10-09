// OpenCode V2 plugin: on rate limit, quota, overload or auth errors, record a
// block in plugin storage, then move the failing session to the best
// (model, account) pair that is not blocked, and retry the same step.
//
// - Model changes are per session (session.switchModel). The plugin never
//   moves a session back up by itself, so prompt caches survive.
// - Account changes are global per integration (connection.activate): a
//   blocked account is blocked for every session.
// - Accounts come from normal OpenCode logins (`opencode auth login`, /connect).
// - Retry hook errors carry no headers, so http.response keeps the headers of
//   the last failed response per session for exact reset times.

import { Plugin, Rpc } from '@opencode/plugin'
import {
  blockKey,
  classify,
  DEFAULT_MODELS,
  ENV_ACCOUNT,
  formatModel,
  parseModel,
  pick,
  isBlock,
  type Block,
  type ModelRef,
} from './fallback.ts'

export * from './fallback.ts'

const OBJECT = { type: 'object' } as const

// `client.rpc(FallbackRpc)` reads blocks and receives `switched` events
// (`rpc.fallback.switched` on the event stream).
export const FallbackRpc = Rpc.define({
  id: 'fallback',
  methods: {
    blocks: { input: OBJECT, output: OBJECT },
  },
  events: {
    switched: { schema: OBJECT },
  },
})

export default Plugin.define({
  id: 'fallback',
  async setup(ctx) {
    const ranking = (Array.isArray(ctx.options.models) ? ctx.options.models : DEFAULT_MODELS)
      .flatMap((entry) => (typeof entry === 'string' ? [parseModel(entry)] : []))
      .filter((model) => model !== undefined)

    // TODO: drop the optional type once @opencode/plugin ships connection.activate. https://github.com/anomalyco/opencode/pull/52797
    const connection: typeof ctx.integration.connection & { activate?: (credentialID: string) => Promise<void> } =
      ctx.integration.connection

    // Last model request per session: which account it used, and the headers when it failed.
    const requests = new Map<string, { kind: string; credentialID: string; headers?: Record<string, string> }>()

    async function integrationOf(providerID: string) {
      const provider = await ctx.provider.get({ providerID }).catch(() => undefined)
      return provider?.data.integrationID ?? providerID
    }

    async function activeCredential(providerID: string) {
      const active = await connection.active(await integrationOf(providerID)).catch(() => undefined)
      return active?.type === 'credential' ? active.id : ENV_ACCOUNT
    }

    // Saved accounts of a provider, active first. Without activate only the active one is usable.
    async function accountsOf(providerID: string) {
      const integration = await ctx.integration.get({ integrationID: await integrationOf(providerID) }).catch(() => undefined)
      const ids = (integration?.data.connections ?? []).flatMap((item) => (item.type === 'credential' ? [item.id] : []))
      if (ids.length === 0) return [ENV_ACCOUNT]
      return connection.activate ? ids : ids.slice(0, 1)
    }

    async function readBlocks(now: number) {
      const blocks: Block[] = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix: 'block/', after, limit: 1000 })
        for (const entry of page.entries) {
          if (!isBlock(entry.value) || entry.value.until <= now) await ctx.storage.remove(entry.key)
          else blocks.push(entry.value)
        }
        after = page.next
      } while (after)
      return blocks
    }

    async function saveBlock(block: Block) {
      const key = blockKey(block)
      const existing = await ctx.storage.get(key)
      if (isBlock(existing) && existing.until >= block.until) return
      await ctx.storage.set(key, block)
    }

    // Ranking filtered to models this location can use. The failed model keeps its
    // own variant; a model outside the ranking is tried first (other accounts).
    async function rankingFor(failed: ModelRef) {
      const models = await ctx.model.list()
      const usable = ranking.filter((model) =>
        models.data.some(
          (info) =>
            info.providerID === model.providerID &&
            info.id === model.id &&
            (!model.variant || info.variants.some((variant) => variant.id === model.variant)),
        ),
      )
      const same = (model: ModelRef) => model.providerID === failed.providerID && model.id === failed.id
      if (!usable.some(same)) return [failed, ...usable]
      return usable.map((model) => (same(model) ? failed : model))
    }

    const rpc = await ctx.rpc.register(FallbackRpc, {
      blocks: async () => ({ blocks: await readBlocks(Date.now()) }),
    })

    await ctx.session.hook('model.request', async (event) => {
      requests.set(event.sessionID, { kind: event.kind, credentialID: await activeCredential(event.model.providerID) })
    })

    await ctx.session.hook('http.response', (event) => {
      if (event.response.ok) return
      const request = requests.get(event.sessionID)
      if (!request) return
      request.headers = Object.fromEntries(event.response.headers)
    })

    await ctx.session.hook('retry', async (event) => {
      const request = requests.get(event.sessionID)
      requests.delete(event.sessionID)
      // Compaction keeps its prepared request across retries, so a model switch would not apply.
      if (request && request.kind !== 'primary') return
      const now = Date.now()
      const block = classify({
        failed: {
          model: event.model,
          credentialID: request?.credentialID ?? ENV_ACCOUNT,
          error: event.error,
          headers: request?.headers,
        },
        now,
      })
      if (!block) return
      await saveBlock(block)

      const candidates = await rankingFor(event.model)
      const providers = [...new Set(candidates.map((model) => model.providerID))]
      const accounts = Object.fromEntries(
        await Promise.all(providers.map(async (providerID) => [providerID, await accountsOf(providerID)] as const)),
      )
      const choice = pick({ ranking: candidates, accounts, blocks: await readBlocks(now), now })
      if (!choice) return

      if (choice.credentialID !== ENV_ACCOUNT && connection.activate) {
        if ((await activeCredential(choice.model.providerID)) !== choice.credentialID) {
          await connection.activate(choice.credentialID)
        }
      }
      await ctx.session.switchModel({ sessionID: event.sessionID, model: choice.model })
      event.decision = { retry: true, delay: choice.waitUntil === undefined ? 0 : Math.max(0, choice.waitUntil - now) }

      await rpc.events.emit('switched', {
        sessionID: event.sessionID,
        from: formatModel(event.model),
        to: formatModel(choice.model),
        credentialID: choice.credentialID,
        reason: block.reason,
        blockedUntil: block.until,
        ...(choice.waitUntil === undefined ? {} : { waitUntil: choice.waitUntil }),
      })
    })
  },
})
