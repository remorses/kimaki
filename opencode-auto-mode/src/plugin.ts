import type { Plugin } from '@opencode/plugin'
import { AutoModeClassifier, type MainModel } from './classify.ts'
import { getDefaultConfig, loadConfig } from './config.ts'
import { decide } from './decide.ts'

export function sessionContextFromMessages({
  messages,
  model,
}: {
  messages: ReadonlyArray<{
    role: string
    content: ReadonlyArray<{ type: string; text?: string | null }>
  }>
  model: MainModel
}) {
  const message = messages.findLast((entry) => entry.role === 'user')
  const userText = (message?.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim())
    .map((part) => part.text)
    .join('\n')
  if (!userText) return { kind: 'error' as const }
  return { kind: 'ok' as const, userText, mainModel: model }
}

export function createAutoModeSetup({
  alwaysEnabled,
}: {
  alwaysEnabled: boolean
}): Plugin.Plugin['setup'] {
  return async (ctx) => {
    if (process.env.KIMAKI === '1' && !alwaysEnabled) return
    const loaded = loadConfig({ projectDir: ctx.location.directory })
    if (loaded.kind === 'disabled' && !alwaysEnabled) return
    const invalidReason = loaded.kind === 'invalid' ? loaded.reason : undefined
    const config = loaded.kind === 'enabled' ? loaded.config : getDefaultConfig()
    const classifier = new AutoModeClassifier(ctx.generate.text)
    const sessionContexts = new Map<string, { userText: string; mainModel: MainModel }>()
    const eventAbort = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventAbort.signal })) {
          if (event.type === 'session.deleted') {
            sessionContexts.delete(event.data.sessionID)
          }
        }
      } catch {
        // Plugin cleanup aborts the subscription.
      }
    })()

    await ctx.session.hook('context', (event) => {
      const context = sessionContextFromMessages({
        messages: event.messages,
        model: event.model,
      })
      if (context.kind === 'error') {
        sessionContexts.delete(event.sessionID)
        return
      }
      sessionContexts.set(event.sessionID, context)
    })

    await ctx.tool.transform((editor) => {
      for (const item of editor.list()) {
        editor.update(item.id, (tool) => {
          const execute = tool.execute
          tool.execute = async (input, toolContext) => {
            if (invalidReason) throw new Error(`[auto-mode] ${invalidReason}`)
            const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
            const decision = decide({
              tool: item.id,
              args,
              cwd: ctx.location.directory,
            })
            if (decision.kind === 'deny') throw new Error(`[auto-mode] ${decision.reason}`)
            if (decision.kind === 'classify') {
              const context = sessionContexts.get(toolContext.sessionID)
              if (!context) {
                throw new Error(
                  '[auto-mode] The current user turn could not be loaded; auto mode fails closed.',
                )
              }
              const result = await classifier
                .classify({
                  config,
                  input: {
                    tool: item.id,
                    args,
                    userText: context.userText,
                  },
                  mainModel: context.mainModel,
                })
                .catch((error) => ({
                  decision: 'block' as const,
                  reason: error instanceof Error ? error.message : String(error),
                }))
              if (result.decision === 'block') throw new Error(`[auto-mode] ${result.reason}`)
            }
            return execute(input, toolContext)
          }
        })
      }
    })
    return () => eventAbort.abort()
  }
}
