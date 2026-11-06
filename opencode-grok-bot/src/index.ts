// OpenCode V2 plugin: Grok Bot as a provider. Every bot and group of the connected
// account is a model (`grok-bot/<bot slug>`, bots.ts); a session talks to that bot like the app does.
//
//   integration methods ──▶ "Grok Bot account" (browser sign-in, many accounts) or "desktop app"
//   provider.transform  ──▶ models from listAgents of the active account (sourceConnection)
//   aisdk "sdk" hook    ──▶ GrokBotLanguageModel for the account in `apiKey` (language-model.ts)
//   each turn           ──▶ slug ▶ bot ID (aliases keep renamed slugs); unknown slugs create a bot
//   model.request hook  ──▶ marks the request kind, so only chat turns reach the bot
//   title / compaction  ──▶ answered locally: the bot keeps its own history
//
// Like the Claude Agent provider (anomalyco/opencode packages/core/src/plugin/provider/claude-agent),
// OpenCode stores and refreshes the account credential; the desktop method reads the app's login.

import { Credential, Integration, Model, Plugin, type Provider } from '@opencode/plugin'
import type { ConnectionInfo } from '@opencode/client'
import { assignSlugs, resolveSlug, updateAliases, type Aliases, type Bot } from './bots.ts'
import { createAgent, createGrokBotClient, jwtClaims, listAgents, pollLogin, readDesktopLogin, refreshLogin, startLogin, type GrokBotClient } from './grok-bot.ts'
import { GrokBotLanguageModel, KIND_HEADER, PROVIDER_ID } from './language-model.ts'

export * from './bots.ts'
export * from './grok-bot.ts'
export { GrokBotLanguageModel, latestUserText, runTurn } from './language-model.ts'
export * from './transcript.ts'

const PACKAGE = '@kimaki/plugin-grok-bot'
export const ACCOUNT_METHOD_ID: Integration.MethodID = Integration.MethodID.make('grok-bot-account')
const DESKTOP_METHOD_ID: Integration.MethodID = Integration.MethodID.make('grok-bot-desktop')
const DESKTOP_ACCOUNT = 'desktop'
const STORAGE_KEY = 'inventory'
const ALIASES_KEY = 'aliases'
const CURSOR_PREFIX = 'seen/'
const LIST_TIMEOUT_MS = 150_000
// Bots have no token limit OpenCode can see; a large window keeps it from compacting.
const CONTEXT_TOKENS = 1_000_000
const MAX_TITLE_CHARS = 60
const SECONDS_MS = 1_000

type Inventory = { connection: ConnectionInfo; bots: Bot[] }

function savedInventory(value: unknown): Inventory | null {
  if (!value || typeof value !== 'object') return null
  const inventory = value as { connection?: ConnectionInfo; bots?: unknown }
  if (!inventory.connection || !Array.isArray(inventory.bots)) return null
  const bots = inventory.bots.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const bot = item as Record<string, unknown>
    if (typeof bot.id !== 'string' || typeof bot.name !== 'string') return []
    return [{ id: bot.id, name: bot.name, isGroup: bot.isGroup === true, createdAt: typeof bot.createdAt === 'number' ? bot.createdAt : undefined }]
  })
  return { connection: inventory.connection, bots }
}

function toModel({ slug, bot }: { slug: string; bot: Bot }): Model.Info {
  const defaults = Model.Info.default(PROVIDER_ID as Provider.ID, slug as Model.ID)
  return {
    ...defaults,
    name: bot.isGroup ? `${bot.name} (group)` : bot.name,
    limit: { context: CONTEXT_TOKENS, output: 0 },
    capabilities: { tools: true, input: ['text'], output: ['text'] },
  }
}

// First line of the first user text, shortened.
export function titleFrom(text: string) {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? 'Grok Bot'
  const trimmed = line.trim()
  return trimmed.length > MAX_TITLE_CHARS ? `${trimmed.slice(0, MAX_TITLE_CHARS - 1)}…` : trimmed
}

type TextMessage = { role: string; content: ReadonlyArray<{ type: string; text?: string }> | string }

function firstUserText(messages: ReadonlyArray<TextMessage>) {
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') return message.content
    const text = message.content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n')
    if (text) return text
  }
  return ''
}

function oauthCredential({ accessToken, refreshToken }: { accessToken: string; refreshToken: string }) {
  const expiresSeconds = jwtClaims(accessToken).exp
  return Credential.OAuth.make({
    type: 'oauth',
    methodID: ACCOUNT_METHOD_ID,
    access: accessToken,
    refresh: refreshToken,
    // A token without `exp` is refreshed on the next request.
    expires: expiresSeconds ? expiresSeconds * SECONDS_MS : 0,
  })
}

// OpenCode's OAuth callbacks fail by rejecting.
function credentialOrThrow(tokens: { accessToken: string; refreshToken: string } | Error) {
  if (tokens instanceof Error) throw tokens
  return oauthCredential(tokens)
}

export default Plugin.define({
  id: 'grok-bot',
  async setup(ctx) {
    // One client per account, keyed by the token's user.
    const tokens = new Map<string, string>()
    const clients = new Map<string, GrokBotClient>()
    const clientFor = (accessToken: string | undefined) => {
      const account = accessToken ? (jwtClaims(accessToken).sub ?? accessToken) : DESKTOP_ACCOUNT
      if (accessToken) tokens.set(account, accessToken)
      const existing = clients.get(account)
      if (existing) return { account, client: existing }
      const client = accessToken
        ? createGrokBotClient({ token: async () => ({ accessToken: tokens.get(account) ?? accessToken, teamId: null }) })
        : createGrokBotClient({ token: readDesktopLogin })
      clients.set(account, client)
      return { account, client }
    }

    // Old slugs of every bot, per account, so a renamed bot keeps its model ID.
    const loadAliases = async (account: string): Promise<Aliases> => {
      const all = await ctx.storage.get(ALIASES_KEY)
      const value = all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, unknown>)[account] : undefined
      return value && typeof value === 'object' ? (value as Aliases) : {}
    }
    const saveAliases = async ({ account, bots }: { account: string; bots: Bot[] }) => {
      const all = await ctx.storage.get(ALIASES_KEY)
      const record = all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, Aliases>) : {}
      const next = updateAliases({ aliases: await loadAliases(account), slugs: assignSlugs(bots) })
      await ctx.storage.set(ALIASES_KEY, { ...record, [account]: next })
      return next
    }

    // Where each session stopped reading each bot's transcript, so the next turn shows what came later.
    const cursor = {
      get: async (key: string) => {
        const value = await ctx.storage.get(`${CURSOR_PREFIX}${key}`).catch(() => undefined)
        return typeof value === 'number' ? value : null
      },
      set: (key: string, seq: number) => ctx.storage.set(`${CURSOR_PREFIX}${key}`, seq),
    }

    // Two turns on a new slug must create one bot, not two.
    const creating = new Map<string, Promise<string | Error>>()
    const resolveBot = async ({ account, client, slug, signal }: { account: string; client: GrokBotClient; slug: string; signal: AbortSignal }) => {
      const bots = await listAgents({ client, signal })
      if (bots instanceof Error) return bots
      // A model only listed in opencode.json creates its bot under the configured name.
      const models = await ctx.model.list().catch(() => null)
      const name = models?.data.find((model) => model.providerID === PROVIDER_ID && model.id === slug)?.name
      const resolution = resolveSlug({ slug, bots, aliases: await saveAliases({ account, bots }), name })
      if (resolution.type === 'bot') return resolution.bot.id
      const key = `${account}\n${slug}`
      const pending =
        creating.get(key) ??
        createAgent({ client, name: resolution.name, signal }).finally(() => {
          creating.delete(key)
          refreshInBackground()
        })
      creating.set(key, pending)
      return pending
    }

    await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = 'Grok Bot'
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: ACCOUNT_METHOD_ID, type: 'oauth', label: 'Grok Bot account (browser sign-in)' },
        authorize: async () => {
          const login = startLogin()
          return {
            mode: 'auto',
            url: login.url,
            instructions: 'Sign in with the Cursor account of your Grok Bot, then approve. The login finishes by itself.',
            callback: pollLogin({ ...login, signal: AbortSignal.timeout(LIST_TIMEOUT_MS * 5) }).then(credentialOrThrow),
          }
        },
        refresh: async (credential) => credentialOrThrow(await refreshLogin({ refreshToken: credential.refresh, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })),
        label: (credential) => {
          const claims = jwtClaims(credential.access)
          return claims.email ?? claims.sub
        },
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: DESKTOP_METHOD_ID, type: 'external', label: 'Grok Bot desktop app (macOS, reads its login from the Keychain)' },
      })
    })

    let inventory = savedInventory(await ctx.storage.get(STORAGE_KEY))

    await ctx.provider.transform((editor) => {
      editor.add({
        info: { id: PROVIDER_ID as Provider.ID, name: 'Grok Bot', activation: 'auto', package: `aisdk:${PACKAGE}` },
        models: [...assignSlugs(inventory?.bots ?? [])].map(([slug, bot]) => toModel({ slug, bot })),
        // OpenCode hides these models while another account is active, until refresh lists its bots.
        ...(inventory ? { sourceConnection: inventory.connection } : {}),
      })
    })

    const refresh = async () => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
      if (!connection) return
      const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)
      const { account, client } = clientFor(credential?.type === 'oauth' ? credential.access : undefined)
      const bots = await listAgents({ client, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
      // Another account may have become active while this one listed its bots.
      const active = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
      if (JSON.stringify(active) !== JSON.stringify(connection)) return
      if (bots instanceof Error) {
        await ctx.integration.connection.status({ integrationID: PROVIDER_ID, connection, status: { status: 'needs_auth', message: bots.message } }).catch(() => undefined)
        return
      }
      const next: Inventory = { connection, bots }
      await saveAliases({ account, bots: next.bots })
      if (JSON.stringify(next) === JSON.stringify(inventory)) return
      inventory = next
      await ctx.storage.set(STORAGE_KEY, inventory)
      await ctx.provider.reload()
    }
    const refreshInBackground = () => void refresh().catch((cause) => console.warn('[grok-bot] bot list refresh failed', cause))
    refreshInBackground()

    // A new or switched account lists its own bots.
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ['credential.switched', 'credential.updated'] })) {
        if (event.type === 'credential.switched' && event.data.integrationID !== PROVIDER_ID) continue
        refreshInBackground()
      }
    })().catch((cause) => console.warn('[grok-bot] credential events stopped', cause))

    await ctx.aisdk.hook(
      'sdk',
      (event) => {
        if (event.package !== PACKAGE) return
        // OpenCode passes the active account's OAuth access token as `apiKey`; the desktop method passes none.
        const apiKey = typeof event.options.apiKey === 'string' && event.options.apiKey ? event.options.apiKey : undefined
        const { account, client } = clientFor(apiKey)
        event.sdk = {
          languageModel: (modelID: string) => new GrokBotLanguageModel(modelID, client, ({ slug, signal }) => resolveBot({ account, client, slug, signal }), cursor),
        }
      },
      { providerID: PROVIDER_ID },
    )

    await ctx.session.hook(
      'model.request',
      (event) => {
        event.headers[KIND_HEADER] = event.kind
      },
      { providerID: PROVIDER_ID },
    )

    // The bot keeps its own history, so OpenCode never needs to ask it for a title or summary.
    await ctx.session.hook(
      'title',
      (event) => {
        event.result = titleFrom(firstUserText(event.messages as ReadonlyArray<TextMessage>))
      },
      { providerID: PROVIDER_ID },
    )
    await ctx.session.hook(
      'compaction',
      (event) => {
        event.result = { summary: 'The conversation continues in Grok Bot, which keeps its own history and memory.' }
      },
      { providerID: PROVIDER_ID },
    )

    // A retried turn would send the prompt to the bot twice.
    await ctx.session.hook(
      'retry',
      (event) => {
        event.decision = { retry: false }
      },
      { providerID: PROVIDER_ID },
    )
  },
})
