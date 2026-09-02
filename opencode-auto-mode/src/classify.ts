// Side-session classifier. Deny-all permissions. Fail closed.

import type { PluginInput } from '@opencode-ai/plugin'
import {
  DETAILED_INSTRUCTION,
  FAST_INSTRUCTION,
  parseDetailedDecision,
  parseFastDecision,
} from './classifier.ts'
import type { AutoModeConfig } from './config.ts'
import { parseModelId } from './config.ts'

const DENY_ALL_PERMISSIONS = [{ permission: '*', pattern: '*', action: 'deny' as const }]

type PluginClient = PluginInput['client']

export type ClassifyInput = {
  tool: string
  args: unknown
  userText: string
}

export type ClassifyResult =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string }

function textFromPrompt(response: { data?: { parts?: Array<{ type: string; text?: string }> } }) {
  const parts = response.data?.parts ?? []
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

export class AutoModeClassifier {
  private client: PluginClient
  private tmpDir: string

  constructor({
    client,
    directory,
  }: {
    client: PluginClient
    directory: string
  }) {
    this.client = client
    this.tmpDir = directory
  }

  async classify({
    config,
    input,
  }: {
    config: AutoModeConfig
    input: ClassifyInput
  }): Promise<ClassifyResult> {
    const sessionId = await this.createSession()
    const model = parseModelId(config.model)
    const payload = JSON.stringify({
      tool: input.tool,
      args: input.args,
      user: input.userText,
    })

    const fast = await this.prompt({
      sessionId,
      model,
      system: FAST_INSTRUCTION,
      text: `STAGE=fast\n${payload}`,
    })
    const fastDecision = parseFastDecision(fast)
    if (fastDecision === 'invalid') {
      this.deleteSession(sessionId)
      return { decision: 'block', reason: 'Fast classifier response was not 0 or 1; auto mode fails closed.' }
    }
    if (fastDecision === 'allow') {
      this.deleteSession(sessionId)
      return { decision: 'allow' }
    }

    const detailed = await this.prompt({
      sessionId,
      model,
      system: DETAILED_INSTRUCTION,
      text: `STAGE=detailed\n${payload}`,
    })
    this.deleteSession(sessionId)
    const parsed = parseDetailedDecision(detailed)
    if (!parsed) {
      return { decision: 'block', reason: 'Classifier response was not valid decision JSON; auto mode fails closed.' }
    }
    if (parsed.decision === 'allow') return { decision: 'allow' }
    return { decision: 'block', reason: parsed.reason }
  }

  private async prompt({
    sessionId,
    model,
    system,
    text,
  }: {
    sessionId: string
    model: { providerID: string; modelID: string }
    system: string
    text: string
  }) {
    const response = await this.client.session.prompt({
      path: { id: sessionId },
      body: {
        model,
        system,
        parts: [{ type: 'text', text }],
      },
      query: { directory: this.tmpDir },
    })
    return textFromPrompt(response)
  }

  private async createSession() {
    const session = await this.client.session.create({
      body: {
        permission: DENY_ALL_PERMISSIONS,
      } as { parentID?: string; title?: string },
      query: { directory: this.tmpDir },
    })
    if (!session.data) {
      throw new Error('Failed to create auto-mode classifier session')
    }
    return session.data.id
  }

  private deleteSession(sessionId: string) {
    this.client.session
      .delete({
        path: { id: sessionId },
        query: { directory: this.tmpDir },
      })
      .catch(() => {})
  }
}
