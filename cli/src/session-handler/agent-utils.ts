// Agent preference resolution utility.
// Validates agent preferences against the OpenCode API.
// When a requested agent is not found, we fall back to the default agent
// instead of throwing. This handles stale agent preferences from CLI send
// commands or database references to agents that were removed from config.


import {
  getSessionAgent,
  getSessionModel,
  getChannelAgent,
} from '../database.js'
import { createLogger } from '../logger.js'
import { OpenCodeSdkError } from '../errors.js'
import { type initializeOpencodeForDirectory } from '../opencode.js'
import { type AgentInfo } from '../system-message.js'

const agentLogger = createLogger('agent')

export function findAgentByName<T extends { id?: string; name: string }>({
  agents,
  name,
}: {
  agents: T[]
  name: string
}) {
  const needle = name.toLowerCase()
  return agents.find((agent) => {
    return agent.name.toLowerCase() === needle || agent.id?.toLowerCase() === needle
  })
}

export async function resolveValidatedAgentPreference({
  agent,
  sessionId,
  channelId,
  getClient,
  directory,
}: {
  agent?: string
  sessionId: string
  channelId?: string
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
  directory?: string
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

  if (!agentPreference) {
    return { agentPreference: undefined, agents: [] }
  }

  const agentsResponse = await getClient().agent.list(
    directory ? { location: { directory } } : undefined,
  )
    .catch((e) => new OpenCodeSdkError({ operation: 'agent.list', cause: e }))
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

  const matchedAgent = findAgentByName({
    agents: availableAgents,
    name: agentPreference,
  })
  if (matchedAgent) {
    return { agentPreference: matchedAgent.id || matchedAgent.name, agents }
  }

  // Fall back to default agent instead of erroring. This handles stale
  // preferences from CLI send commands or removed agents in config.
  agentLogger.warn(
    `Agent "${agentPreference}" not found, falling back to default agent`,
  )
  return { agentPreference: undefined, agents }
}
