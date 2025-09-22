# Documenting OpenCode SDK capabilities and types

## Session Information

- **Created**: Sep 2, 2025, 3:07 PM
- **Updated**: Sep 2, 2025, 4:19 PM
- **OpenCode Version**: v0.6.3

## Conversation

### 👤 User

read the .d.ts for the opencode sdk inside node_modules. see package.json for cli first. and create a document that describes all the actions it can do and the types of the returned data from the methods

### 👤 User

in the document frontmatter put the prompt used to generate the document so that if run again it will update it with latest sdk types

### 🤖 Assistant (claude-opus-4-1-20250805)

#### 🛠️ Tool: edit

**Input:**

```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/cli/OPENCODE_SDK_DOCUMENTATION.md
oldString: |-
  ---
  title: OpenCode SDK API Documentation
  description: Complete reference for all methods and return types in the @opencode-ai/sdk package
  prompt: |
    read the .d.ts for the opencode sdk inside node_modules. see package.json for cli first.
    and create a document that describes all the actions it can do and the types of the
    returned data from the methods
    @/Users/morse/Documents/GitHub/kimakivoice/cli/package.json
    @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
    @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
  ---
newString: |-
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
```

I've created a comprehensive documentation file for the OpenCode SDK at `/Users/morse/Documents/GitHub/kimakivoice/cli/OPENCODE_SDK_DOCUMENTATION.md` that covers:

- **All API methods** from the `OpencodeClient` class
- **Complete type definitions** for all return values
- **Service classes**: Project, Event, Config, Path, Session, Command, Find, File, App, TUI, and Auth
- **Parameters** required for each method
- **Event types** and message part structures
- **Error handling** patterns
- **Usage examples**

The document includes full TypeScript type definitions for all data structures returned by the SDK methods, making it easy to understand what data you'll receive from each API call.

_Completed in 31.4s_

### 🤖 Assistant (claude-opus-4-1-20250805)

#### 🛠️ Tool: edit

**Input:**

```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/cli/OPENCODE_SDK_DOCUMENTATION.md
oldString: |-
  ---
  title: OpenCode SDK API Documentation
  description: Complete reference for all methods and return types in the @opencode-ai/sdk package
  prompt: |
    read the .d.ts for the opencode sdk inside node_modules. see package.json for cli first.
    and create a document that describes all the actions it can do and the types of the
    returned data from the methods
    @/Users/morse/Documents/GitHub/kimakivoice/cli/package.json
    @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
    @/Users/morse/Documents/GitHub/kimakivoice/cli/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
  ---
newString: |-
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
```

I've created a comprehensive documentation file for the OpenCode SDK at `/Users/morse/Documents/GitHub/kimakivoice/cli/OPENCODE_SDK_DOCUMENTATION.md` that covers:

- **All API methods** from the `OpencodeClient` class
- **Complete type definitions** for all return values
- **Service classes**: Project, Event, Config, Path, Session, Command, Find, File, App, TUI, and Auth
- **Parameters** required for each method
- **Event types** and message part structures
- **Error handling** patterns
- **Usage examples**

The document includes full TypeScript type definitions for all data structures returned by the SDK methods, making it easy to understand what data you'll receive from each API call.

### 👤 User

### 🤖 Assistant (gpt-5-nano)

**Started using openai/gpt-5-nano**

### 👤 User

### 👤 User

In what directory is the agent currently located?

### 🤖 Assistant (gpt-5-nano)

**Started using openai/gpt-5-nano**

`/Users/morse/Documents/GitHub/kimakivoice/cli` (the CLI directory).

_Completed in 3.5s_

### 🤖 Assistant (gpt-5-nano)

**Started using openai/gpt-5-nano**

`/Users/morse/Documents/GitHub/kimakivoice/cli` (the CLI directory).

### 👤 User

What model are you currently using?

### 🤖 Assistant (gpt-5-nano)

**Started using openai/gpt-5-nano**

I don’t have access to the exact model name. The backend selects the model and I operate within that. If you need specifics, check the platform’s docs or settings. What would you like me to do next?

_Completed in 12.1s_
