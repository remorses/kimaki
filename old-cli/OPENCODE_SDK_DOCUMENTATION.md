---
title: OpenCode SDK API Documentation
description: Complete reference for all methods and return types in the @opencode-ai/sdk package
prompt: |
  read the .d.ts for the opencode sdk inside node_modules. see package.json 
  for cli first. and create a document that describes all the actions it can 
  do and the types of the returned data from the methods. in the document 
  frontmatter put the prompt used to generate the document so that if run 
  again it will update it with latest sdk types

  Files to read:
  @/Users/morse/Documents/GitHub/kimakivoice/cli/package.json
  @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/index.d.ts
  @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/client.d.ts
  @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/server.d.ts
  @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
  @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts

  The document should include:
  - All available methods from OpencodeClient class
  - Parameters required for each method
  - Return types with full type definitions
  - Event types and their structures
  - Part types for messages
  - Error handling information
  - Usage examples
---

# OpenCode SDK API Documentation

The OpenCode SDK (`@opencode-ai/sdk`) provides a comprehensive TypeScript client for interacting with the OpenCode AI platform. This document covers all available methods and their return types.

## Installation

```bash
npm install @opencode-ai/sdk
```

## Client Initialization

```typescript
import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk';

// Create client
const client = createOpencodeClient(config);

// Create server
const server = await createOpencodeServer({
  hostname?: string,
  port?: number,
  signal?: AbortSignal,
  timeout?: number
});
```

## Main Client Classes

The SDK provides the following main service classes through the `OpencodeClient`:

### OpencodeClient

The main client exposes these service instances:

- `project` - Project management
- `event` - Event subscription
- `config` - Configuration management
- `path` - Path information
- `session` - Session management
- `command` - Command execution
- `find` - Search functionality
- `file` - File operations
- `app` - Application utilities
- `tui` - Terminal UI operations
- `auth` - Authentication

## API Methods

### Project Service

#### `project.list(options?)`

Lists all available projects.

**Returns:** `Array<Project>`

```typescript
type Project = {
  id: string
  worktree: string
  vcs?: 'git'
  time: {
    created: number
    initialized?: number
  }
}
```

#### `project.current(options?)`

Gets the current active project.

**Returns:** `Project`

### Event Service

#### `event.subscribe(options?)`

Subscribes to server-sent events stream.

**Returns:** `ServerSentEventsResult<Event>`

Event types include:

- `installation.updated`
- `lsp.client.diagnostics`
- `message.updated`
- `message.removed`
- `message.part.updated`
- `message.part.removed`
- `permission.updated`
- `permission.replied`
- `file.edited`
- `session.updated`
- `session.deleted`
- `session.idle`
- `session.error`
- `server.connected`

### Config Service

#### `config.get(options?)`

Gets the current configuration.

**Returns:** `Config`

```typescript
type Config = {
  $schema?: string
  theme?: string
  keybinds?: KeybindsConfig
  tui?: { scroll_speed: number }
  command?: { [key: string]: CommandConfig }
  plugin?: Array<string>
  snapshot?: boolean
  share?: 'manual' | 'auto' | 'disabled'
  autoupdate?: boolean
  disabled_providers?: Array<string>
  model?: string
  small_model?: string
  username?: string
  agent?: { [key: string]: AgentConfig }
  provider?: { [key: string]: ProviderConfig }
  mcp?: { [key: string]: McpConfig }
  formatter?: { [key: string]: FormatterConfig }
  lsp?: { [key: string]: LspConfig }
  instructions?: Array<string>
  permission?: PermissionConfig
  tools?: { [key: string]: boolean }
  experimental?: ExperimentalConfig
}
```

#### `config.providers(options?)`

Lists all available providers.

**Returns:** `{ [key: string]: Provider }`

```typescript
type Provider = {
  api?: string
  name: string
  env: Array<string>
  id: string
  npm?: string
  models: { [key: string]: Model }
}
```

### Path Service

#### `path.get(options?)`

Gets path information.

**Returns:** `Path`

```typescript
type Path = {
  state: string
  config: string
  worktree: string
  directory: string
}
```

### Session Service

#### `session.list(options?)`

Lists all sessions.

**Returns:** `Array<Session>`

```typescript
type Session = {
  id: string
  projectID: string
  directory: string
  parentID?: string
  share?: { url: string }
  title: string
  version: string
  time: {
    created: number
    updated: number
  }
  revert?: {
    messageID: string
    partID?: string
    snapshot?: string
    diff?: string
  }
}
```

#### `session.create(options?)`

Creates a new session.

**Parameters:**

- `parentID?: string`
- `title?: string`

**Returns:** `Session`

#### `session.delete(options)`

Deletes a session and all its data.

**Parameters:**

- `id: string` (required)

**Returns:** `boolean`

#### `session.get(options)`

Gets a specific session.

**Parameters:**

- `id: string` (required)

**Returns:** `Session`

#### `session.update(options)`

Updates session properties.

**Parameters:**

- `id: string` (required)
- `title?: string`

**Returns:** `Session`

#### `session.children(options)`

Gets a session's children.

**Parameters:**

- `id: string` (required)

**Returns:** `Array<Session>`

#### `session.init(options)`

Analyzes the app and creates an AGENTS.md file.

**Parameters:**

- `id: string` (required)
- `messageID: string`
- `providerID: string`
- `modelID: string`

**Returns:** `boolean`

#### `session.abort(options)`

Aborts a session.

**Parameters:**

- `id: string` (required)

**Returns:** `boolean`

#### `session.share(options)`

Shares a session.

**Parameters:**

- `id: string` (required)

**Returns:** `Session`

#### `session.unshare(options)`

Unshares the session.

**Parameters:**

- `id: string` (required)

**Returns:** `Session`

#### `session.summarize(options)`

Summarizes the session.

**Parameters:**

- `id: string` (required)
- `providerID: string`
- `modelID: string`

**Returns:** `boolean`

#### `session.messages(options)`

Lists messages for a session.

**Parameters:**

- `id: string` (required)

**Returns:** `Array<{ info: Message, parts: Array<Part> }>`

```typescript
type Message = UserMessage | AssistantMessage

type UserMessage = {
  id: string
  sessionID: string
  role: 'user'
  time: { created: number }
}

type AssistantMessage = {
  id: string
  sessionID: string
  role: 'assistant'
  time: {
    created: number
    completed?: number
  }
  error?: Error
  system: Array<string>
  modelID: string
  providerID: string
  mode: string
  path: { cwd: string; root: string }
  summary?: boolean
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}
```

#### `session.prompt(options)`

Creates and sends a new message to a session. This method waits for the LLM to complete its response before returning.

**Parameters:**

- `id: string` (required)
- `messageID?: string`
- `model?: { providerID: string; modelID: string }`
- `agent?: string`
- `system?: string`
- `tools?: { [key: string]: boolean }`
- `parts: Array<TextPartInput | FilePartInput | AgentPartInput>`

**Returns:** `{ info: AssistantMessage, parts: Array<Part> }`

**Note:** This method is synchronous and will wait for the complete LLM response before returning. If you need to send a message without waiting for the response, you can call this method without awaiting it.

#### `session.message(options)`

Gets a message from a session.

**Parameters:**

- `id: string` (required)
- `messageID: string` (required)

**Returns:** `{ info: Message, parts: Array<Part> }`

#### `session.command(options)`

Sends a new command to a session.

**Parameters:**

- `id: string` (required)
- `messageID?: string`
- `agent?: string`
- `model?: string`
- `arguments: string`
- `command: string`

**Returns:** `{ info: AssistantMessage, parts: Array<Part> }`

#### `session.shell(options)`

Runs a shell command.

**Parameters:**

- `id: string` (required)
- `agent: string`
- `command: string`

**Returns:** `AssistantMessage`

#### `session.revert(options)`

Reverts a message.

**Parameters:**

- `id: string` (required)
- `messageID: string`
- `partID?: string`

**Returns:** `Session`

#### `session.unrevert(options)`

Restores all reverted messages.

**Parameters:**

- `id: string` (required)

**Returns:** `Session`

### Command Service

#### `command.list(options?)`

Lists all available commands.

**Returns:** `Array<Command>`

```typescript
type Command = {
  name: string
  description?: string
  agent?: string
  model?: string
  template: string
}
```

### Find Service

#### `find.text(options)`

Finds text in files.

**Parameters:**

- `query: string` (required)
- `path?: string`
- `caseSensitive?: boolean`
- `wholeWord?: boolean`
- `regex?: boolean`
- `include?: string`
- `exclude?: string`

**Returns:** Search results with file locations

#### `find.files(options)`

Finds files.

**Parameters:**

- `query: string` (required)
- `path?: string`

**Returns:** Array of file paths

#### `find.symbols(options)`

Finds workspace symbols.

**Parameters:**

- `query: string` (required)

**Returns:** `Array<Symbol>`

```typescript
type Symbol = {
  name: string
  kind: number
  location: {
    uri: string
    range: Range
  }
}
```

### File Service

#### `file.list(options)`

Lists files and directories.

**Parameters:**

- `path: string` (required)

**Returns:** `Array<FileNode>`

```typescript
type FileNode = {
  name: string
  path: string
  type: 'file' | 'directory'
  ignored: boolean
}
```

#### `file.read(options)`

Reads a file.

**Parameters:**

- `path: string` (required)
- `start?: number`
- `end?: number`

**Returns:** File content as string

#### `file.status(options?)`

Gets file status.

**Returns:** `Array<File>`

```typescript
type File = {
  path: string
  added: number
  removed: number
  status: 'added' | 'deleted' | 'modified'
}
```

### App Service

#### `app.log(options?)`

Writes a log entry to the server logs.

**Parameters:**

- `level?: "debug" | "info" | "warn" | "error"`
- `message: string`

**Returns:** `boolean`

#### `app.agents(options?)`

Lists all agents.

**Returns:** `Array<Agent>`

```typescript
type Agent = {
  name: string
  description?: string
  mode: 'subagent' | 'primary' | 'all'
  builtIn: boolean
  topP?: number
  temperature?: number
  permission: {
    edit: 'ask' | 'allow' | 'deny'
    bash: { [key: string]: 'ask' | 'allow' | 'deny' }
    webfetch?: 'ask' | 'allow' | 'deny'
  }
  model?: { modelID: string; providerID: string }
  prompt?: string
  tools: { [key: string]: boolean }
  options: { [key: string]: unknown }
}
```

### TUI Service

#### `tui.appendPrompt(options?)`

Appends prompt to the TUI.

**Parameters:**

- `text: string`

**Returns:** `boolean`

#### `tui.openHelp(options?)`

Opens the help dialog.

**Returns:** `boolean`

#### `tui.openSessions(options?)`

Opens the session dialog.

**Returns:** `boolean`

#### `tui.openThemes(options?)`

Opens the theme dialog.

**Returns:** `boolean`

#### `tui.openModels(options?)`

Opens the model dialog.

**Returns:** `boolean`

#### `tui.submitPrompt(options?)`

Submits the prompt.

**Returns:** `boolean`

#### `tui.clearPrompt(options?)`

Clears the prompt.

**Returns:** `boolean`

#### `tui.executeCommand(options?)`

Executes a TUI command (e.g. agent_cycle).

**Parameters:**

- `command: string`

**Returns:** `boolean`

#### `tui.showToast(options?)`

Shows a toast notification in the TUI.

**Parameters:**

- `message: string`
- `type?: "info" | "success" | "warning" | "error"`

**Returns:** `boolean`

### Auth Service

#### `auth.set(options)`

Sets authentication credentials.

**Parameters:**

- `auth: OAuth | ApiAuth | WellKnownAuth` (required)

**Returns:** `Auth`

```typescript
type OAuth = {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
}

type ApiAuth = {
  type: 'api'
  key: string
}

type WellKnownAuth = {
  type: 'wellknown'
  key: string
  token: string
}
```

## Part Types

Message parts represent different types of content within messages:

```typescript
type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart

type TextPart = {
  id: string
  sessionID: string
  messageID: string
  type: 'text'
  text: string
  synthetic?: boolean
  time?: { start: number; end?: number }
}

type FilePart = {
  id: string
  sessionID: string
  messageID: string
  type: 'file'
  mime: string
  filename?: string
  url: string
  source?: FilePartSource
}

type ToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: 'tool'
  callID: string
  tool: string
  state: ToolState
}

type ToolState =
  | { status: 'pending' }
  | {
      status: 'running'
      input?: unknown
      title?: string
      metadata?: any
      time: { start: number }
    }
  | {
      status: 'completed'
      input: any
      output: string
      title: string
      metadata: any
      time: { start: number; end: number }
    }
  | {
      status: 'error'
      input: any
      error: string
      metadata?: any
      time: { start: number; end: number }
    }
```

## Error Handling

All methods can throw errors with the following structure:

```typescript
type Error = {
  data: {
    [key: string]: unknown
  }
}
```

Common error types include:

- `ProviderAuthError` - Authentication issues with providers
- `UnknownError` - General errors
- `MessageOutputLengthError` - Output length exceeded
- `MessageAbortedError` - Message was aborted

## Usage Example

```typescript
import { createOpencodeClient } from '@opencode-ai/sdk'

const client = createOpencodeClient()

// List sessions
const sessions = await client.session.list()

// Create a new session
const newSession = await client.session.create({
  body: { title: 'My New Session' },
})

// Send a prompt
const response = await client.session.prompt({
  path: { id: newSession.id },
  body: {
    parts: [{ type: 'text', text: 'Hello, can you help me?' }],
  },
})

// Subscribe to events
const events = await client.event.subscribe()
```
