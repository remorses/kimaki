import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import * as acp from '@zed-industries/agent-client-protocol'

// Example 1: What ACP CAN do - Create a new chat session
export async function createNewChat() {
  const agentProcess = spawn('your-agent-executable', [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const input = Writable.toWeb(agentProcess.stdin!)
  const output = Readable.toWeb(agentProcess.stdout!)

  const client = new ExampleClient()
  const connection = new acp.ClientSideConnection(
    (_agent) => client,
    input,
    output
  )

  // Initialize connection
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
  })

  // Create a new session
  const session = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  })

  // Send a message
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [
      {
        type: 'text',
        text: 'Hello, agent!',
      },
    ],
  })

  return { sessionId: session.sessionId, result }
}

// Example 2: What ACP CAN'T do - List recent chats
export async function listRecentChats() {
  // ❌ NOT POSSIBLE with ACP
  // There is no API endpoint like:
  // connection.listSessions()
  // connection.getRecentChats()
  // connection.searchSessions()
  
  throw new Error(
    'ACP does not provide chat listing functionality. ' +
    'The protocol has no concept of chat history or folders.'
  )
}

// Example 3: What ACP CAN'T do - Start chat with default model
export async function startChatWithDefaultModel(message: string, model: string) {
  // ❌ NOT POSSIBLE to specify model
  // ACP's newSession API doesn't accept model parameters:
  /*
  await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
    model: 'claude-3', // ❌ This field doesn't exist!
  })
  */
  
  throw new Error(
    'ACP does not support model selection. ' +
    'Model choice is determined by the agent implementation, not the protocol.'
  )
}

// Example 4: What ACP CAN'T do - Add message to existing chat
export async function addMessageToRecentChat(chatId: string, message: string) {
  // ❌ PARTIALLY POSSIBLE but limited
  // You can only send messages to ACTIVE sessions:
  
  // This works for active sessions:
  /*
  await connection.prompt({
    sessionId: activeSessionId,
    prompt: [{ type: 'text', text: message }],
  })
  */
  
  // But you cannot:
  // 1. Get a list of available session IDs
  // 2. Append to a historical/closed session
  // 3. Modify past conversations
  
  throw new Error(
    'ACP only supports sending messages to active sessions. ' +
    'There is no API to retrieve or modify historical chats.'
  )
}

// Example 5: What ACP CAN'T do - Read chats as markdown
export async function readRecentChatsAsMarkdown() {
  // ❌ NOT POSSIBLE
  // When you load a session, it REPLAYS it via notifications:
  /*
  await connection.loadSession({
    sessionId: 'sess_123',
    cwd: process.cwd(),
    mcpServers: [],
  })
  // This triggers session/update notifications, not returns markdown
  */
  
  throw new Error(
    'ACP does not provide chat export functionality. ' +
    'Session loading replays conversations via streaming updates, ' +
    'not as retrievable markdown content.'
  )
}

// Example 6: What ACP CAN'T do - Read in-progress messages
export async function readInProgressAssistantMessage(sessionId: string) {
  // ❌ NOT POSSIBLE to query current state
  // Messages are pushed via notifications:
  /*
  client.sessionUpdate = (params) => {
    if (params.update.sessionUpdate === 'agent_message_chunk') {
      // You receive chunks here, but can't query them
    }
  }
  */
  
  throw new Error(
    'ACP uses a push model for messages. ' +
    'There is no API to query the current state of an in-progress message. ' +
    'You must capture and store updates as they arrive.'
  )
}

// Client implementation showing what IS possible
class ExampleClient implements acp.Client {
  private messageBuffer: string = ''
  
  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    console.log('Permission requested:', params.toolCall.title)
    return {
      outcome: {
        outcome: 'selected',
        optionId: params.options[0]?.optionId || '',
      },
    }
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          // This is the ONLY way to receive messages - as they stream
          this.messageBuffer += update.content.text
          console.log('Received chunk:', update.content.text)
        }
        break
        
      case 'tool_call':
        console.log('Tool call:', update.title, update.status)
        break
    }
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    console.log('Write file:', params.path)
    return null
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    console.log('Read file:', params.path)
    return { content: 'File content' }
  }
}

// Summary: Why ACP can't do what you want
export const limitations = {
  chatManagement: 'ACP has no chat management APIs - no list, search, or organize',
  modelSelection: 'Model choice is agent-specific, not protocol-level',
  historicalAccess: 'No APIs to access or modify past conversations',
  dataRetrieval: 'Sessions stream updates, not queryable as data',
  stateInspection: 'No APIs to inspect current agent/message state',
}