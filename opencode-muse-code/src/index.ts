// OpenCode V2 plugin: Muse Code (Meta) as a provider. Every Muse model is a model
// (`muse/muse-spark-1.3`); a session talks to one Muse session that runs Muse's own agent loop
// and tools inside its OS sandbox, on this machine.
//
//   integration methods ──▶ "Meta account" (device login, many accounts) or `muse login`
//   provider.transform  ──▶ models from `model/list` of the active account (sourceConnection)
//   aisdk "sdk" hook    ──▶ MuseLanguageModel for the account key in `apiKey` (language-model.ts)
//   context hook        ──▶ the OpenCode agent prompt, sent once to a new Muse session
//   permission bridge   ──▶ Muse approvals become OpenCode permission asks (`muse.shell`, ...)
//   title / compaction  ──▶ answered locally: Muse keeps its own history
//
// Like the Claude Agent provider (anomalyco/opencode packages/core/src/plugin/provider/claude-agent),
// the model loop stays in the vendor's binary.

import { Credential, Integration, Model, Plugin, type Provider } from '@opencode/plugin'
import type { ConnectionInfo } from '@opencode/client'
import type { ApprovalMode, ApprovalRequestParams, ModelCatalogEntry } from '@muse-code/sdk/dist/src/msp.js'
import { createMuseRuntime, findMuse, mintKey, pollLogin, startLogin } from './muse.ts'
import { AGENT_PROMPT_OPTION, KIND_HEADER, MuseLanguageModel, PROVIDER_ID } from './language-model.ts'

export * from './muse.ts'
export * from './items.ts'
export { MuseLanguageModel, earlierConversation, preamble, turnFailure, turnInput, usageOf } from './language-model.ts'

const PACKAGE = '@kimaki/plugin-muse-code'
export const ACCOUNT_METHOD_ID: Integration.MethodID = Integration.MethodID.make('muse-account')
const CLI_METHOD_ID: Integration.MethodID = Integration.MethodID.make('muse-login')
const STORAGE_KEY = 'inventory'
const LOGIN_TIMEOUT_MS = 15 * 60_000
const LIST_TIMEOUT_MS = 60_000
// The Muse Code key has no expiry OpenCode can see and no refresh token; a 401 asks for /connect.
const KEY_LIFETIME_MS = 10 * 365 * 24 * 60 * 60_000
const DEFAULT_CONTEXT_TOKENS = 1_048_576
const MAX_TITLE_CHARS = 60
// Shown before the first login lists the account's models.
const DEFAULT_MODELS: ModelCatalogEntry[] = [
  { modelId: 'muse-spark-1.3', displayLabel: 'Muse Spark 1.3', providerId: 'meta', profileId: null, releaseDate: null, description: null, contextLimit: null, outputLimit: null, cost: null, isActive: false, isDefault: true },
  { modelId: 'muse-wonder-1.0', displayLabel: 'Muse Wonder 1.0', providerId: 'meta', profileId: null, releaseDate: null, description: null, contextLimit: DEFAULT_CONTEXT_TOKENS, outputLimit: null, cost: null, isActive: false, isDefault: false },
]
const DEFAULT_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const APPROVAL_MODES = ['allowAll', 'promptUnmatched', 'onRequest', 'denyUnmatched'] as const satisfies readonly ApprovalMode[]

type SavedModel = { id: string; name: string; context: number | null; output: number | null; efforts: string[] }
type Inventory = { connection: ConnectionInfo; models: SavedModel[] }

function toSaved(rows: readonly ModelCatalogEntry[]): SavedModel[] {
  return rows.map((row) => ({
    id: row.modelId,
    name: row.displayLabel || row.modelId,
    context: row.contextLimit,
    output: row.outputLimit,
    efforts: Array.isArray(row.variants) ? [...row.variants] : DEFAULT_EFFORTS,
  }))
}

function savedInventory(value: unknown): Inventory | null {
  if (!value || typeof value !== 'object') return null
  const inventory = value as { connection?: ConnectionInfo; models?: unknown }
  if (!inventory.connection || !Array.isArray(inventory.models)) return null
  const models = inventory.models.flatMap((item): SavedModel[] => {
    if (!item || typeof item !== 'object') return []
    const model = item as Record<string, unknown>
    if (typeof model.id !== 'string' || typeof model.name !== 'string') return []
    const context = typeof model.context === 'number' ? model.context : null
    const output = typeof model.output === 'number' ? model.output : null
    const efforts = Array.isArray(model.efforts) ? model.efforts.filter((effort): effort is string => typeof effort === 'string') : DEFAULT_EFFORTS
    return [{ id: model.id, name: model.name, context, output, efforts }]
  })
  return { connection: inventory.connection, models }
}

function toModel(model: SavedModel): Model.Info {
  const defaults = Model.Info.default(PROVIDER_ID as Provider.ID, model.id as Model.ID)
  return {
    ...defaults,
    name: model.name,
    limit: { context: model.context ?? DEFAULT_CONTEXT_TOKENS, output: model.output ?? 0 },
    capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    variants: model.efforts.map((effort) => ({ id: Model.VariantID.make(effort), settings: { reasoningEffort: effort } })),
  }
}

// First line of the first user text, shortened.
export function titleFrom(text: string) {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? 'Muse Code'
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

// One OpenCode permission per Muse approval: `muse.<kind>` on the command, path, host or tool.
export function permissionFor(request: ApprovalRequestParams) {
  const subject = request.subject
  const resource = subject.command ?? subject.path ?? (subject.host ? `${subject.host}${subject.port ? `:${subject.port}` : ''}` : undefined) ?? subject.target ?? subject.toolName ?? request.toolName
  return {
    action: `muse.${subject.kind}`,
    resources: [resource],
    metadata: { tool: request.toolName, arguments: request.rawArgs, ...(request.reviewerReason ? { reason: request.reviewerReason } : {}) },
  }
}

async function loginCredential({ signal }: { signal: AbortSignal }) {
  const login = await startLogin({ signal })
  if (login instanceof Error) return login
  const callback = (async () => {
    const accessToken = await pollLogin({ login, signal })
    if (accessToken instanceof Error) throw accessToken
    const key = await mintKey({ accessToken, signal })
    if (key instanceof Error) throw key
    return Credential.OAuth.make({
      type: 'oauth',
      methodID: ACCOUNT_METHOD_ID,
      access: key.apiKey,
      refresh: '',
      expires: Date.now() + KEY_LIFETIME_MS,
      metadata: { accountId: key.accountId, ...(key.email ? { email: key.email } : {}) },
    })
  })()
  // OpenCode awaits the callback after it shows the code; a failure before that is still reported there.
  callback.catch(() => undefined)
  return { login, callback }
}

export default Plugin.define({
  id: 'muse-code',
  async setup(ctx) {
    const provider = typeof ctx.options.provider === 'string' ? ctx.options.provider : 'meta'
    const extraArgs = Array.isArray(ctx.options.args) ? ctx.options.args.filter((arg): arg is string => typeof arg === 'string') : []
    const trustWorkspace = ctx.options.trustWorkspace !== false
    const approvalMode = APPROVAL_MODES.find((mode) => mode === ctx.options.approvalMode) ?? 'onRequest'
    const permissionProfile = typeof ctx.options.permissionProfile === 'string' ? ctx.options.permissionProfile : null

    const runtime = createMuseRuntime({
      host: {
        bin: typeof ctx.options.bin === 'string' ? ctx.options.bin : findMuse(),
        // Muse asks questions as plain text; OpenCode has no surface for its question cards.
        args: ['--provider', provider, '--disable-request-user-input', ...(trustWorkspace ? ['--trust-workspace'] : []), ...extraArgs],
      },
      directory: ctx.location.directory,
      storage: { get: (key) => ctx.storage.get(key), set: (key, value) => ctx.storage.set(key, value) },
      approve: async ({ sessionID, request }) => {
        const permission = permissionFor(request)
        return ctx.permission.assert({ sessionID, ...permission }).then(
          () => true,
          () => false,
        )
      },
    })

    await ctx.integration.transform((editor) => {
      editor.update(PROVIDER_ID, (integration) => {
        integration.name = 'Muse Code'
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: ACCOUNT_METHOD_ID, type: 'oauth', label: 'Meta account with a Muse Code subscription (device login)' },
        authorize: async () => {
          const started = await loginCredential({ signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS) })
          if (started instanceof Error) throw started
          return {
            mode: 'auto',
            url: started.login.url,
            instructions: `Sign in with Meta and enter the code ${started.login.userCode}. The login finishes by itself.`,
            expiresAt: started.login.expiresAt,
            callback: started.callback,
          }
        },
        label: (credential) => {
          const email = credential.metadata?.email
          return typeof email === 'string' ? email : 'Muse Code account'
        },
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { id: CLI_METHOD_ID, type: 'external', label: 'Muse Code CLI login (run `muse login` first)' },
      })
    })

    let inventory = savedInventory(await ctx.storage.get(STORAGE_KEY))

    await ctx.provider.transform((editor) => {
      editor.add({
        info: { id: PROVIDER_ID as Provider.ID, name: 'Muse Code', activation: 'auto', package: `aisdk:${PACKAGE}` },
        models: (inventory?.models.length ? inventory.models : toSaved(DEFAULT_MODELS)).map(toModel),
        // OpenCode hides these models while another account is active, until refresh lists its models.
        ...(inventory ? { sourceConnection: inventory.connection } : {}),
      })
    })

    const activeKey = async () => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID).catch(() => undefined)
      if (!connection) return null
      const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)
      return { connection, apiKey: credential?.type === 'oauth' ? credential.access : null }
    }

    const refresh = async () => {
      const active = await activeKey()
      if (!active) return
      const rows = await runtime.models({ apiKey: active.apiKey })
      if (rows instanceof Error) {
        await ctx.integration.connection.status({ integrationID: PROVIDER_ID, connection: active.connection, status: { status: 'needs_auth', message: rows.message } }).catch(() => undefined)
        return
      }
      // `muse` lists no models until it has a login.
      if (rows.length === 0) return
      const next: Inventory = { connection: active.connection, models: toSaved(rows) }
      if (JSON.stringify(next) === JSON.stringify(inventory)) return
      inventory = next
      await ctx.storage.set(STORAGE_KEY, inventory)
      await ctx.provider.reload()
    }
    const refreshInBackground = () => void refresh().catch((cause) => console.warn('[muse-code] model list refresh failed', cause))
    refreshInBackground()

    // A new or switched account lists its own models.
    void (async () => {
      for await (const event of ctx.event.subscribe({ types: ['credential.switched', 'credential.updated'] })) {
        if (event.type === 'credential.switched' && event.data.integrationID !== PROVIDER_ID) continue
        refreshInBackground()
      }
    })().catch((cause) => console.warn('[muse-code] credential events stopped', cause))

    await ctx.aisdk.hook(
      'sdk',
      (event) => {
        if (event.package !== PACKAGE) return
        // OpenCode passes the active account's key as `apiKey`; the `muse login` method passes none.
        const apiKey = typeof event.options.apiKey === 'string' && event.options.apiKey ? event.options.apiKey : null
        event.sdk = { languageModel: (modelID: string) => new MuseLanguageModel({ modelId: modelID, runtime, apiKey, defaults: { approvalMode, permissionProfile } }) }
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

    // The agent's own prompt is the only OpenCode instruction Muse gets; Muse reads AGENTS.md itself.
    await ctx.session.hook(
      'context',
      async (event) => {
        const agent = await ctx.agent.get({ agentID: event.agent }).catch(() => undefined)
        event.options[AGENT_PROMPT_OPTION] = agent?.data.system ?? ''
      },
      { providerID: PROVIDER_ID },
    )

    // Muse keeps its own history, so OpenCode never needs to ask it for a title or summary.
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
        event.result = { summary: 'The conversation continues in Muse Code, which keeps its own history and compacts it itself.' }
      },
      { providerID: PROVIDER_ID },
    )

    // Muse already retried its model calls; a replayed turn would run its tools again.
    // A used-up plan or a lost login is left to OpenCode, so the fallback plugin can switch account.
    await ctx.session.hook(
      'retry',
      (event) => {
        if (event.error.type === 'provider.rate-limit' || event.error.type === 'provider.quota' || event.error.type === 'provider.auth') return
        event.decision = { retry: false }
      },
      { providerID: PROVIDER_ID },
    )

    return async () => {
      await runtime.close()
    }
  },
})

