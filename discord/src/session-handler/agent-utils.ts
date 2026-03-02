// Agent preference resolution utility.
// Validates agent preferences against the OpenCode API.
// Extracted from session-handler.ts during Phase 5 migration.

import * as errore from 'errore'
import {
  getSessionAgent,
  getSessionModel,
  getChannelAgent,
} from '../database.js'
import { type initializeOpencodeForDirectory } from '../opencode.js'
import { type AgentInfo } from '../system-message.js'

export async function resolveValidatedAgentPreference({
  agent,
  sessionId,
  channelId,
  getClient,
}: {
  agent?: string
  sessionId: string
  channelId?: string
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
}): Promise<{ agentPreference?: string; agents: AgentInfo[] }> {
  const agentPreference = await (async (): Promise<string | undefined> => {
    if (agent) {
      return agent
    }

    const sessionAgent = await getSessionAgent(sessionId)
    if (sessionAgent) {
      return sessionAgent
    }

    const sessionModel = await getSessionModel(sessionId)
    if (sessionModel) {
      return undefined
    }

    if (!channelId) {
      return undefined
    }
    return getChannelAgent(channelId)
  })()

  if (getClient instanceof Error) {
    return { agentPreference: agentPreference || undefined, agents: [] }
  }

  const agentsResponse = await errore.tryAsync(() => {
    return getClient().app.agents({})
  })
  if (agentsResponse instanceof Error) {
    if (agentPreference) {
      throw new Error(`Failed to validate agent "${agentPreference}"`, {
        cause: agentsResponse,
      })
    }
    return { agentPreference: undefined, agents: [] }
  }

  const availableAgents = agentsResponse.data || []
  // Non-hidden primary/all agents for system message context
  const agents: AgentInfo[] = availableAgents
    .filter((a) => {
      return (
        (a.mode === 'primary' || a.mode === 'all') &&
        !a.hidden
      )
    })
    .map((a) => {
      return { name: a.name, description: a.description }
    })

  if (!agentPreference) {
    return { agentPreference: undefined, agents }
  }

  const hasAgent = availableAgents.some((availableAgent) => {
    return availableAgent.name === agentPreference
  })
  if (hasAgent) {
    return { agentPreference, agents }
  }

  const availableAgentNames = availableAgents
    .map((availableAgent) => {
      return availableAgent.name
    })
    .slice(0, 20)
  const availableAgentsMessage =
    availableAgentNames.length > 0
      ? `Available agents: ${availableAgentNames.join(', ')}`
      : 'No agents are available in this project.'
  throw new Error(
    `Agent "${agentPreference}" not found. ${availableAgentsMessage} Use /agent to choose a valid one.`,
  )
}
