# Agent Client Protocol (ACP) Capabilities

## What ACP Can Do

The Agent Client Protocol (ACP) is designed for communication between code editors (clients) and AI coding agents. Here's what it provides:

### Core Capabilities

1. **Session Management**
   - Create new conversation sessions
   - Load existing sessions (if agent supports it)
   - Maintain conversation history
   - Connect to MCP (Model Context Protocol) servers for tools

2. **Message Exchange**
   - Send user prompts with text, images, and file resources
   - Receive agent responses in chunks
   - Support for streaming responses
   - Tool call execution and status updates

3. **File System Access**
   - Read text files from the client's environment
   - Write/modify files (if client allows)
   - Agents can request file operations during execution

4. **Permission System**
   - Agents can request permission for sensitive operations
   - Clients control what agents can do

### What ACP CANNOT Do (Based on Your Requirements)

Unfortunately, ACP does **NOT** provide the following capabilities you requested:

1. **❌ List recent chats and their folders**
   - ACP has no built-in chat history API
   - Sessions are identified by IDs but there's no list/search functionality
   - No folder organization concept

2. **❌ Start a new chat with a message and user default model**
   - Can create sessions but model selection is agent-specific
   - No concept of "default model" in the protocol

3. **❌ Add a message to a recent chat**
   - Can only send messages to active sessions via `prompt`
   - No API to append to historical chats

4. **❌ Read recent chats as markdown**
   - No API to retrieve chat history
   - Sessions can only be "loaded" which replays them, not read as data

5. **❌ Read an in-progress chat assistant message**
   - Messages are streamed to the client, not queryable
   - No API to inspect current agent state

## Why These Limitations Exist

ACP is designed as a **runtime protocol** for active agent-client communication, not as a **chat management system**. It assumes:

- The client (editor) manages chat history and persistence
- Sessions are ephemeral communication channels
- Historical data is the client's responsibility

## Possible Workarounds

To achieve your goals, you would need to:

1. **Build a persistence layer** on top of ACP that stores sessions
2. **Implement your own chat management** system
3. **Use the client-side** to track and store conversations
4. **Create a wrapper** that provides the missing APIs

The protocol is focused on real-time agent execution, not chat history management.