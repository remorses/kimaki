# Exploring OpenCode and Plugin SDK Events

## Conversation

### 👤 User

read the .d.ts for the opencode sdk and plugin sdk. then explain me what each event does and what the sdk can do.


### 🤖 Assistant (claude-opus-4-20250514)

**Started using anthropic/claude-opus-4-20250514**

I'll help you understand the opencode SDK and plugin SDK by reading their TypeScript definition files. Let me search for these files first.

#### 🛠️ Tool: bash

**Input:**
```yaml
command: find . -name "*.d.ts" -type f | grep -E "(sdk|plugin)" | head -20
description: Search for .d.ts files related to SDK or plugin
```

**Output:**
```
./node_modules/.pnpm/@ai-sdk+gateway@1.0.15_zod@4.1.5/node_modules/@ai-sdk/gateway/dist/index.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/babel.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/meriyah.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/markdown.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/glimmer.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/acorn.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/estree.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/postcss.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/flow.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/angular.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/yaml.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/html.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/graphql.d.ts
./node_modules/.pnpm/prettier@3.3.3/node_modules/prettier/plugins/typescript.d.ts
./node_modules/.pnpm/@opencode-ai+plugin@0.6.3_typescript@5.9.2/node_modules/@opencode-ai/plugin/dist/example.d.ts
./node_modules/.pnpm/@opencode-ai+plugin@0.6.3_typescript@5.9.2/node_modules/@opencode-ai/plugin/dist/shell.d.ts
./node_modules/.pnpm/@opencode-ai+plugin@0.6.3_typescript@5.9.2/node_modules/@opencode-ai/plugin/dist/index.d.ts
./node_modules/.pnpm/@hey-api+json-schema-ref-parser@1.0.6/node_modules/@hey-api/json-schema-ref-parser/dist/lib/util/plugins.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/server.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts

```

Let me read the opencode SDK and plugin SDK definition files:

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
```

**Output:**
```
<file>
00001| import type { Options as ClientOptions, TDataShape, Client } from "./client/index.js";
00002| import type { EventSubscribeData, EventSubscribeResponses, AppGetData, AppGetResponses, AppInitData, AppInitResponses, ConfigGetData, ConfigGetResponses, SessionListData, SessionListResponses, SessionCreateData, SessionCreateResponses, SessionCreateErrors, SessionDeleteData, SessionDeleteResponses, SessionGetData, SessionGetResponses, SessionUpdateData, SessionUpdateResponses, SessionChildrenData, SessionChildrenResponses, SessionInitData, SessionInitResponses, SessionAbortData, SessionAbortResponses, SessionUnshareData, SessionUnshareResponses, SessionShareData, SessionShareResponses, SessionSummarizeData, SessionSummarizeResponses, SessionMessagesData, SessionMessagesResponses, SessionChatData, SessionChatResponses, SessionMessageData, SessionMessageResponses, SessionCommandData, SessionCommandResponses, SessionShellData, SessionShellResponses, SessionRevertData, SessionRevertResponses, SessionUnrevertData, SessionUnrevertResponses, PostSessionByIdPermissionsByPermissionIdData, PostSessionByIdPermissionsByPermissionIdResponses, CommandListData, CommandListResponses, ConfigProvidersData, ConfigProvidersResponses, FindTextData, FindTextResponses, FindFilesData, FindFilesResponses, FindSymbolsData, FindSymbolsResponses, FileReadData, FileReadResponses, FileStatusData, FileStatusResponses, AppLogData, AppLogResponses, AppAgentsData, AppAgentsResponses, TuiAppendPromptData, TuiAppendPromptResponses, TuiOpenHelpData, TuiOpenHelpResponses, TuiOpenSessionsData, TuiOpenSessionsResponses, TuiOpenThemesData, TuiOpenThemesResponses, TuiOpenModelsData, TuiOpenModelsResponses, TuiSubmitPromptData, TuiSubmitPromptResponses, TuiClearPromptData, TuiClearPromptResponses, TuiExecuteCommandData, TuiExecuteCommandResponses, TuiShowToastData, TuiShowToastResponses, AuthSetData, AuthSetResponses, AuthSetErrors } from "./types.gen.js";
00003| export type Options<TData extends TDataShape = TDataShape, ThrowOnError extends boolean = boolean> = ClientOptions<TData, ThrowOnError> & {
00004|     /**
00005|      * You can provide a client instance returned by `createClient()` instead of
00006|      * individual options. This might be also useful if you want to implement a
00007|      * custom client.
00008|      */
00009|     client?: Client;
00010|     /**
00011|      * You can pass arbitrary values through the `meta` object. This can be
00012|      * used to access values that aren't defined as part of the SDK function.
00013|      */
00014|     meta?: Record<string, unknown>;
00015| };
00016| declare class _HeyApiClient {
00017|     protected _client: Client;
00018|     constructor(args?: {
00019|         client?: Client;
00020|     });
00021| }
00022| declare class Event extends _HeyApiClient {
00023|     /**
00024|      * Get events
00025|      */
00026|     subscribe<ThrowOnError extends boolean = false>(options?: Options<EventSubscribeData, ThrowOnError>): import("./client/types.js").RequestResult<EventSubscribeResponses, unknown, ThrowOnError, "fields">;
00027| }
00028| declare class App extends _HeyApiClient {
00029|     /**
00030|      * Get app info
00031|      */
00032|     get<ThrowOnError extends boolean = false>(options?: Options<AppGetData, ThrowOnError>): import("./client/types.js").RequestResult<AppGetResponses, unknown, ThrowOnError, "fields">;
00033|     /**
00034|      * Initialize the app
00035|      */
00036|     init<ThrowOnError extends boolean = false>(options?: Options<AppInitData, ThrowOnError>): import("./client/types.js").RequestResult<AppInitResponses, unknown, ThrowOnError, "fields">;
00037|     /**
00038|      * Write a log entry to the server logs
00039|      */
00040|     log<ThrowOnError extends boolean = false>(options?: Options<AppLogData, ThrowOnError>): import("./client/types.js").RequestResult<AppLogResponses, unknown, ThrowOnError, "fields">;
00041|     /**
00042|      * List all agents
00043|      */
00044|     agents<ThrowOnError extends boolean = false>(options?: Options<AppAgentsData, ThrowOnError>): import("./client/types.js").RequestResult<AppAgentsResponses, unknown, ThrowOnError, "fields">;
00045| }
00046| declare class Config extends _HeyApiClient {
00047|     /**
00048|      * Get config info
00049|      */
00050|     get<ThrowOnError extends boolean = false>(options?: Options<ConfigGetData, ThrowOnError>): import("./client/types.js").RequestResult<ConfigGetResponses, unknown, ThrowOnError, "fields">;
00051|     /**
00052|      * List all providers
00053|      */
00054|     providers<ThrowOnError extends boolean = false>(options?: Options<ConfigProvidersData, ThrowOnError>): import("./client/types.js").RequestResult<ConfigProvidersResponses, unknown, ThrowOnError, "fields">;
00055| }
00056| declare class Session extends _HeyApiClient {
00057|     /**
00058|      * List all sessions
00059|      */
00060|     list<ThrowOnError extends boolean = false>(options?: Options<SessionListData, ThrowOnError>): import("./client/types.js").RequestResult<SessionListResponses, unknown, ThrowOnError, "fields">;
00061|     /**
00062|      * Create a new session
00063|      */
00064|     create<ThrowOnError extends boolean = false>(options?: Options<SessionCreateData, ThrowOnError>): import("./client/types.js").RequestResult<SessionCreateResponses, SessionCreateErrors, ThrowOnError, "fields">;
00065|     /**
00066|      * Delete a session and all its data
00067|      */
00068|     delete<ThrowOnError extends boolean = false>(options: Options<SessionDeleteData, ThrowOnError>): import("./client/types.js").RequestResult<SessionDeleteResponses, unknown, ThrowOnError, "fields">;
00069|     /**
00070|      * Get session
00071|      */
00072|     get<ThrowOnError extends boolean = false>(options: Options<SessionGetData, ThrowOnError>): import("./client/types.js").RequestResult<SessionGetResponses, unknown, ThrowOnError, "fields">;
00073|     /**
00074|      * Update session properties
00075|      */
00076|     update<ThrowOnError extends boolean = false>(options: Options<SessionUpdateData, ThrowOnError>): import("./client/types.js").RequestResult<SessionUpdateResponses, unknown, ThrowOnError, "fields">;
00077|     /**
00078|      * Get a session's children
00079|      */
00080|     children<ThrowOnError extends boolean = false>(options: Options<SessionChildrenData, ThrowOnError>): import("./client/types.js").RequestResult<SessionChildrenResponses, unknown, ThrowOnError, "fields">;
00081|     /**
00082|      * Analyze the app and create an AGENTS.md file
00083|      */
00084|     init<ThrowOnError extends boolean = false>(options: Options<SessionInitData, ThrowOnError>): import("./client/types.js").RequestResult<SessionInitResponses, unknown, ThrowOnError, "fields">;
00085|     /**
00086|      * Abort a session
00087|      */
00088|     abort<ThrowOnError extends boolean = false>(options: Options<SessionAbortData, ThrowOnError>): import("./client/types.js").RequestResult<SessionAbortResponses, unknown, ThrowOnError, "fields">;
00089|     /**
00090|      * Unshare the session
00091|      */
00092|     unshare<ThrowOnError extends boolean = false>(options: Options<SessionUnshareData, ThrowOnError>): import("./client/types.js").RequestResult<SessionUnshareResponses, unknown, ThrowOnError, "fields">;
00093|     /**
00094|      * Share a session
00095|      */
00096|     share<ThrowOnError extends boolean = false>(options: Options<SessionShareData, ThrowOnError>): import("./client/types.js").RequestResult<SessionShareResponses, unknown, ThrowOnError, "fields">;
00097|     /**
00098|      * Summarize the session
00099|      */
00100|     summarize<ThrowOnError extends boolean = false>(options: Options<SessionSummarizeData, ThrowOnError>): import("./client/types.js").RequestResult<SessionSummarizeResponses, unknown, ThrowOnError, "fields">;
00101|     /**
00102|      * List messages for a session
00103|      */
00104|     messages<ThrowOnError extends boolean = false>(options: Options<SessionMessagesData, ThrowOnError>): import("./client/types.js").RequestResult<SessionMessagesResponses, unknown, ThrowOnError, "fields">;
00105|     /**
00106|      * Create and send a new message to a session
00107|      */
00108|     chat<ThrowOnError extends boolean = false>(options: Options<SessionChatData, ThrowOnError>): import("./client/types.js").RequestResult<SessionChatResponses, unknown, ThrowOnError, "fields">;
00109|     /**
00110|      * Get a message from a session
00111|      */
00112|     message<ThrowOnError extends boolean = false>(options: Options<SessionMessageData, ThrowOnError>): import("./client/types.js").RequestResult<SessionMessageResponses, unknown, ThrowOnError, "fields">;
00113|     /**
00114|      * Send a new command to a session
00115|      */
00116|     command<ThrowOnError extends boolean = false>(options: Options<SessionCommandData, ThrowOnError>): import("./client/types.js").RequestResult<SessionCommandResponses, unknown, ThrowOnError, "fields">;
00117|     /**
00118|      * Run a shell command
00119|      */
00120|     shell<ThrowOnError extends boolean = false>(options: Options<SessionShellData, ThrowOnError>): import("./client/types.js").RequestResult<SessionShellResponses, unknown, ThrowOnError, "fields">;
00121|     /**
00122|      * Revert a message
00123|      */
00124|     revert<ThrowOnError extends boolean = false>(options: Options<SessionRevertData, ThrowOnError>): import("./client/types.js").RequestResult<SessionRevertResponses, unknown, ThrowOnError, "fields">;
00125|     /**
00126|      * Restore all reverted messages
00127|      */
00128|     unrevert<ThrowOnError extends boolean = false>(options: Options<SessionUnrevertData, ThrowOnError>): import("./client/types.js").RequestResult<SessionUnrevertResponses, unknown, ThrowOnError, "fields">;
00129| }
00130| declare class Command extends _HeyApiClient {
00131|     /**
00132|      * List all commands
00133|      */
00134|     list<ThrowOnError extends boolean = false>(options?: Options<CommandListData, ThrowOnError>): import("./client/types.js").RequestResult<CommandListResponses, unknown, ThrowOnError, "fields">;
00135| }
00136| declare class Find extends _HeyApiClient {
00137|     /**
00138|      * Find text in files
00139|      */
00140|     text<ThrowOnError extends boolean = false>(options: Options<FindTextData, ThrowOnError>): import("./client/types.js").RequestResult<FindTextResponses, unknown, ThrowOnError, "fields">;
00141|     /**
00142|      * Find files
00143|      */
00144|     files<ThrowOnError extends boolean = false>(options: Options<FindFilesData, ThrowOnError>): import("./client/types.js").RequestResult<FindFilesResponses, unknown, ThrowOnError, "fields">;
00145|     /**
00146|      * Find workspace symbols
00147|      */
00148|     symbols<ThrowOnError extends boolean = false>(options: Options<FindSymbolsData, ThrowOnError>): import("./client/types.js").RequestResult<FindSymbolsResponses, unknown, ThrowOnError, "fields">;
00149| }
00150| declare class File extends _HeyApiClient {
00151|     /**
00152|      * Read a file
00153|      */
00154|     read<ThrowOnError extends boolean = false>(options: Options<FileReadData, ThrowOnError>): import("./client/types.js").RequestResult<FileReadResponses, unknown, ThrowOnError, "fields">;
00155|     /**
00156|      * Get file status
00157|      */
00158|     status<ThrowOnError extends boolean = false>(options?: Options<FileStatusData, ThrowOnError>): import("./client/types.js").RequestResult<FileStatusResponses, unknown, ThrowOnError, "fields">;
00159| }
00160| declare class Tui extends _HeyApiClient {
00161|     /**
00162|      * Append prompt to the TUI
00163|      */
00164|     appendPrompt<ThrowOnError extends boolean = false>(options?: Options<TuiAppendPromptData, ThrowOnError>): import("./client/types.js").RequestResult<TuiAppendPromptResponses, unknown, ThrowOnError, "fields">;
00165|     /**
00166|      * Open the help dialog
00167|      */
00168|     openHelp<ThrowOnError extends boolean = false>(options?: Options<TuiOpenHelpData, ThrowOnError>): import("./client/types.js").RequestResult<TuiOpenHelpResponses, unknown, ThrowOnError, "fields">;
00169|     /**
00170|      * Open the session dialog
00171|      */
00172|     openSessions<ThrowOnError extends boolean = false>(options?: Options<TuiOpenSessionsData, ThrowOnError>): import("./client/types.js").RequestResult<TuiOpenSessionsResponses, unknown, ThrowOnError, "fields">;
00173|     /**
00174|      * Open the theme dialog
00175|      */
00176|     openThemes<ThrowOnError extends boolean = false>(options?: Options<TuiOpenThemesData, ThrowOnError>): import("./client/types.js").RequestResult<TuiOpenThemesResponses, unknown, ThrowOnError, "fields">;
00177|     /**
00178|      * Open the model dialog
00179|      */
00180|     openModels<ThrowOnError extends boolean = false>(options?: Options<TuiOpenModelsData, ThrowOnError>): import("./client/types.js").RequestResult<TuiOpenModelsResponses, unknown, ThrowOnError, "fields">;
00181|     /**
00182|      * Submit the prompt
00183|      */
00184|     submitPrompt<ThrowOnError extends boolean = false>(options?: Options<TuiSubmitPromptData, ThrowOnError>): import("./client/types.js").RequestResult<TuiSubmitPromptResponses, unknown, ThrowOnError, "fields">;
00185|     /**
00186|      * Clear the prompt
00187|      */
00188|     clearPrompt<ThrowOnError extends boolean = false>(options?: Options<TuiClearPromptData, ThrowOnError>): import("./client/types.js").RequestResult<TuiClearPromptResponses, unknown, ThrowOnError, "fields">;
00189|     /**
00190|      * Execute a TUI command (e.g. agent_cycle)
00191|      */
00192|     executeCommand<ThrowOnError extends boolean = false>(options?: Options<TuiExecuteCommandData, ThrowOnError>): import("./client/types.js").RequestResult<TuiExecuteCommandResponses, unknown, ThrowOnError, "fields">;
00193|     /**
00194|      * Show a toast notification in the TUI
00195|      */
00196|     showToast<ThrowOnError extends boolean = false>(options?: Options<TuiShowToastData, ThrowOnError>): import("./client/types.js").RequestResult<TuiShowToastResponses, unknown, ThrowOnError, "fields">;
00197| }
00198| declare class Auth extends _HeyApiClient {
00199|     /**
00200|      * Set authentication credentials
00201|      */
00202|     set<ThrowOnError extends boolean = false>(options: Options<AuthSetData, ThrowOnError>): import("./client/types.js").RequestResult<AuthSetResponses, AuthSetErrors, ThrowOnError, "fields">;
00203| }
00204| export declare class OpencodeClient extends _HeyApiClient {
00205|     /**
00206|      * Respond to a permission request
00207|      */
00208|     postSessionByIdPermissionsByPermissionId<ThrowOnError extends boolean = false>(options: Options<PostSessionByIdPermissionsByPermissionIdData, ThrowOnError>): import("./client/types.js").RequestResult<PostSessionByIdPermissionsByPermissionIdResponses, unknown, ThrowOnError, "fields">;
00209|     event: Event;
00210|     app: App;
00211|     config: Config;
00212|     session: Session;
00213|     command: Command;
00214|     find: Find;
00215|     file: File;
00216|     tui: Tui;
00217|     auth: Auth;
00218| }
00219| export {};
00220| 
</file>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/node_modules/.pnpm/@opencode-ai+plugin@0.6.3_typescript@5.9.2/node_modules/@opencode-ai/plugin/dist/index.d.ts
```

**Output:**
```
<file>
00001| import type { Event, createOpencodeClient, Project, Model, Provider, Permission, UserMessage, Part, Auth, Config } from "@opencode-ai/sdk";
00002| import type { BunShell } from "./shell";
00003| export type PluginInput = {
00004|     client: ReturnType<typeof createOpencodeClient>;
00005|     project: Project;
00006|     directory: string;
00007|     worktree: string;
00008|     $: BunShell;
00009| };
00010| export type Plugin = (input: PluginInput) => Promise<Hooks>;
00011| export interface Hooks {
00012|     event?: (input: {
00013|         event: Event;
00014|     }) => Promise<void>;
00015|     config?: (input: Config) => Promise<void>;
00016|     auth?: {
00017|         provider: string;
00018|         loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>;
00019|         methods: ({
00020|             type: "oauth";
00021|             label: string;
00022|             authorize(): Promise<{
00023|                 url: string;
00024|                 instructions: string;
00025|             } & ({
00026|                 method: "auto";
00027|                 callback(): Promise<({
00028|                     type: "success";
00029|                 } & ({
00030|                     refresh: string;
00031|                     access: string;
00032|                     expires: number;
00033|                 } | {
00034|                     key: string;
00035|                 })) | {
00036|                     type: "failed";
00037|                 }>;
00038|             } | {
00039|                 method: "code";
00040|                 callback(code: string): Promise<({
00041|                     type: "success";
00042|                 } & ({
00043|                     refresh: string;
00044|                     access: string;
00045|                     expires: number;
00046|                 } | {
00047|                     key: string;
00048|                 })) | {
00049|                     type: "failed";
00050|                 }>;
00051|             })>;
00052|         } | {
00053|             type: "api";
00054|             label: string;
00055|         })[];
00056|     };
00057|     /**
00058|      * Called when a new message is received
00059|      */
00060|     "chat.message"?: (input: {}, output: {
00061|         message: UserMessage;
00062|         parts: Part[];
00063|     }) => Promise<void>;
00064|     /**
00065|      * Modify parameters sent to LLM
00066|      */
00067|     "chat.params"?: (input: {
00068|         model: Model;
00069|         provider: Provider;
00070|         message: UserMessage;
00071|     }, output: {
00072|         temperature: number;
00073|         topP: number;
00074|         options: Record<string, any>;
00075|     }) => Promise<void>;
00076|     "permission.ask"?: (input: Permission, output: {
00077|         status: "ask" | "deny" | "allow";
00078|     }) => Promise<void>;
00079|     "tool.execute.before"?: (input: {
00080|         tool: string;
00081|         sessionID: string;
00082|         callID: string;
00083|     }, output: {
00084|         args: any;
00085|     }) => Promise<void>;
00086|     "tool.execute.after"?: (input: {
00087|         tool: string;
00088|         sessionID: string;
00089|         callID: string;
00090|     }, output: {
00091|         title: string;
00092|         output: string;
00093|         metadata: any;
00094|     }) => Promise<void>;
00095| }
00096| 
</file>
```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/server.d.ts
```

**Output:**
```
<file>
00001| export type ServerConfig = {
00002|     hostname?: string;
00003|     port?: number;
00004|     signal?: AbortSignal;
00005|     timeout?: number;
00006| };
00007| export declare function createOpencodeServer(config?: ServerConfig): Promise<{
00008|     url: string;
00009|     close(): void;
00010| }>;
00011| 
</file>
```

Let me also check for any type definitions related to events to get a complete picture:

#### 🛠️ Tool: bash

**Input:**
```yaml
command: find ./node_modules/.pnpm/@opencode-ai+sdk*/node_modules/@opencode-ai/sdk -name "*.d.ts" | xargs grep -l "Event\|event" | head -10
description: Search for event-related type definitions in SDK
```

**Output:**
```
./node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.5.4/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.5.4/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.6.3_typescript@5.5.4/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.6.3_typescript@5.5.4/node_modules/@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.6.3_typescript@5.5.4/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.6.3_typescript@5.5.4/node_modules/@opencode-ai/sdk/dist/gen/client/types.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.6.3_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts
./node_modules/.pnpm/@opencode-ai+sdk@0.6.3_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.d.ts

```

#### 🛠️ Tool: read

**Input:**
```yaml
filePath: /Users/morse/Documents/GitHub/kimakivoice/node_modules/.pnpm/@opencode-ai+sdk@0.5.28_typescript@5.9.2/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts
limit: 500
```

**Output:**
```
<file>
00001| export type Event = ({
00002|     type: "installation.updated";
00003| } & EventInstallationUpdated) | ({
00004|     type: "lsp.client.diagnostics";
00005| } & EventLspClientDiagnostics) | ({
00006|     type: "message.updated";
00007| } & EventMessageUpdated) | ({
00008|     type: "message.removed";
00009| } & EventMessageRemoved) | ({
00010|     type: "message.part.updated";
00011| } & EventMessagePartUpdated) | ({
00012|     type: "message.part.removed";
00013| } & EventMessagePartRemoved) | ({
00014|     type: "storage.write";
00015| } & EventStorageWrite) | ({
00016|     type: "permission.updated";
00017| } & EventPermissionUpdated) | ({
00018|     type: "permission.replied";
00019| } & EventPermissionReplied) | ({
00020|     type: "file.edited";
00021| } & EventFileEdited) | ({
00022|     type: "session.updated";
00023| } & EventSessionUpdated) | ({
00024|     type: "session.deleted";
00025| } & EventSessionDeleted) | ({
00026|     type: "session.idle";
00027| } & EventSessionIdle) | ({
00028|     type: "session.error";
00029| } & EventSessionError) | ({
00030|     type: "server.connected";
00031| } & EventServerConnected) | ({
00032|     type: "file.watcher.updated";
00033| } & EventFileWatcherUpdated) | ({
00034|     type: "ide.installed";
00035| } & EventIdeInstalled);
00036| export type EventInstallationUpdated = {
00037|     type: "installation.updated";
00038|     properties: {
00039|         version: string;
00040|     };
00041| };
00042| export type EventLspClientDiagnostics = {
00043|     type: "lsp.client.diagnostics";
00044|     properties: {
00045|         serverID: string;
00046|         path: string;
00047|     };
00048| };
00049| export type EventMessageUpdated = {
00050|     type: "message.updated";
00051|     properties: {
00052|         info: Message;
00053|     };
00054| };
00055| export type Message = ({
00056|     role: "user";
00057| } & UserMessage) | ({
00058|     role: "assistant";
00059| } & AssistantMessage);
00060| export type UserMessage = {
00061|     id: string;
00062|     sessionID: string;
00063|     role: "user";
00064|     time: {
00065|         created: number;
00066|     };
00067| };
00068| export type AssistantMessage = {
00069|     id: string;
00070|     sessionID: string;
00071|     role: "assistant";
00072|     time: {
00073|         created: number;
00074|         completed?: number;
00075|     };
00076|     error?: ({
00077|         name: "ProviderAuthError";
00078|     } & ProviderAuthError) | ({
00079|         name: "UnknownError";
00080|     } & UnknownError) | ({
00081|         name: "MessageOutputLengthError";
00082|     } & MessageOutputLengthError) | ({
00083|         name: "MessageAbortedError";
00084|     } & MessageAbortedError);
00085|     system: Array<string>;
00086|     modelID: string;
00087|     providerID: string;
00088|     mode: string;
00089|     path: {
00090|         cwd: string;
00091|         root: string;
00092|     };
00093|     summary?: boolean;
00094|     cost: number;
00095|     tokens: {
00096|         input: number;
00097|         output: number;
00098|         reasoning: number;
00099|         cache: {
00100|             read: number;
00101|             write: number;
00102|         };
00103|     };
00104| };
00105| export type ProviderAuthError = {
00106|     name: "ProviderAuthError";
00107|     data: {
00108|         providerID: string;
00109|         message: string;
00110|     };
00111| };
00112| export type UnknownError = {
00113|     name: "UnknownError";
00114|     data: {
00115|         message: string;
00116|     };
00117| };
00118| export type MessageOutputLengthError = {
00119|     name: "MessageOutputLengthError";
00120|     data: {
00121|         [key: string]: unknown;
00122|     };
00123| };
00124| export type MessageAbortedError = {
00125|     name: "MessageAbortedError";
00126|     data: {
00127|         [key: string]: unknown;
00128|     };
00129| };
00130| export type EventMessageRemoved = {
00131|     type: "message.removed";
00132|     properties: {
00133|         sessionID: string;
00134|         messageID: string;
00135|     };
00136| };
00137| export type EventMessagePartUpdated = {
00138|     type: "message.part.updated";
00139|     properties: {
00140|         part: Part;
00141|     };
00142| };
00143| export type Part = ({
00144|     type: "text";
00145| } & TextPart) | ({
00146|     type: "reasoning";
00147| } & ReasoningPart) | ({
00148|     type: "file";
00149| } & FilePart) | ({
00150|     type: "tool";
00151| } & ToolPart) | ({
00152|     type: "step-start";
00153| } & StepStartPart) | ({
00154|     type: "step-finish";
00155| } & StepFinishPart) | ({
00156|     type: "snapshot";
00157| } & SnapshotPart) | ({
00158|     type: "patch";
00159| } & PatchPart) | ({
00160|     type: "agent";
00161| } & AgentPart);
00162| export type TextPart = {
00163|     id: string;
00164|     sessionID: string;
00165|     messageID: string;
00166|     type: "text";
00167|     text: string;
00168|     synthetic?: boolean;
00169|     time?: {
00170|         start: number;
00171|         end?: number;
00172|     };
00173| };
00174| export type ReasoningPart = {
00175|     id: string;
00176|     sessionID: string;
00177|     messageID: string;
00178|     type: "reasoning";
00179|     text: string;
00180|     metadata?: {
00181|         [key: string]: unknown;
00182|     };
00183|     time: {
00184|         start: number;
00185|         end?: number;
00186|     };
00187| };
00188| export type FilePart = {
00189|     id: string;
00190|     sessionID: string;
00191|     messageID: string;
00192|     type: "file";
00193|     mime: string;
00194|     filename?: string;
00195|     url: string;
00196|     source?: FilePartSource;
00197| };
00198| export type FilePartSource = ({
00199|     type: "file";
00200| } & FileSource) | ({
00201|     type: "symbol";
00202| } & SymbolSource);
00203| export type FileSource = {
00204|     text: FilePartSourceText;
00205|     type: "file";
00206|     path: string;
00207| };
00208| export type FilePartSourceText = {
00209|     value: string;
00210|     start: number;
00211|     end: number;
00212| };
00213| export type SymbolSource = {
00214|     text: FilePartSourceText;
00215|     type: "symbol";
00216|     path: string;
00217|     range: Range;
00218|     name: string;
00219|     kind: number;
00220| };
00221| export type Range = {
00222|     start: {
00223|         line: number;
00224|         character: number;
00225|     };
00226|     end: {
00227|         line: number;
00228|         character: number;
00229|     };
00230| };
00231| export type ToolPart = {
00232|     id: string;
00233|     sessionID: string;
00234|     messageID: string;
00235|     type: "tool";
00236|     callID: string;
00237|     tool: string;
00238|     state: ToolState;
00239| };
00240| export type ToolState = ({
00241|     status: "pending";
00242| } & ToolStatePending) | ({
00243|     status: "running";
00244| } & ToolStateRunning) | ({
00245|     status: "completed";
00246| } & ToolStateCompleted) | ({
00247|     status: "error";
00248| } & ToolStateError);
00249| export type ToolStatePending = {
00250|     status: "pending";
00251| };
00252| export type ToolStateRunning = {
00253|     status: "running";
00254|     input?: unknown;
00255|     title?: string;
00256|     metadata?: {
00257|         [key: string]: unknown;
00258|     };
00259|     time: {
00260|         start: number;
00261|     };
00262| };
00263| export type ToolStateCompleted = {
00264|     status: "completed";
00265|     input: {
00266|         [key: string]: unknown;
00267|     };
00268|     output: string;
00269|     title: string;
00270|     metadata: {
00271|         [key: string]: unknown;
00272|     };
00273|     time: {
00274|         start: number;
00275|         end: number;
00276|     };
00277| };
00278| export type ToolStateError = {
00279|     status: "error";
00280|     input: {
00281|         [key: string]: unknown;
00282|     };
00283|     error: string;
00284|     metadata?: {
00285|         [key: string]: unknown;
00286|     };
00287|     time: {
00288|         start: number;
00289|         end: number;
00290|     };
00291| };
00292| export type StepStartPart = {
00293|     id: string;
00294|     sessionID: string;
00295|     messageID: string;
00296|     type: "step-start";
00297| };
00298| export type StepFinishPart = {
00299|     id: string;
00300|     sessionID: string;
00301|     messageID: string;
00302|     type: "step-finish";
00303|     cost: number;
00304|     tokens: {
00305|         input: number;
00306|         output: number;
00307|         reasoning: number;
00308|         cache: {
00309|             read: number;
00310|             write: number;
00311|         };
00312|     };
00313| };
00314| export type SnapshotPart = {
00315|     id: string;
00316|     sessionID: string;
00317|     messageID: string;
00318|     type: "snapshot";
00319|     snapshot: string;
00320| };
00321| export type PatchPart = {
00322|     id: string;
00323|     sessionID: string;
00324|     messageID: string;
00325|     type: "patch";
00326|     hash: string;
00327|     files: Array<string>;
00328| };
00329| export type AgentPart = {
00330|     id: string;
00331|     sessionID: string;
00332|     messageID: string;
00333|     type: "agent";
00334|     name: string;
00335|     source?: {
00336|         value: string;
00337|         start: number;
00338|         end: number;
00339|     };
00340| };
00341| export type EventMessagePartRemoved = {
00342|     type: "message.part.removed";
00343|     properties: {
00344|         sessionID: string;
00345|         messageID: string;
00346|         partID: string;
00347|     };
00348| };
00349| export type EventStorageWrite = {
00350|     type: "storage.write";
00351|     properties: {
00352|         key: string;
00353|         content?: unknown;
00354|     };
00355| };
00356| export type EventPermissionUpdated = {
00357|     type: "permission.updated";
00358|     properties: Permission;
00359| };
00360| export type Permission = {
00361|     id: string;
00362|     type: string;
00363|     pattern?: string;
00364|     sessionID: string;
00365|     messageID: string;
00366|     callID?: string;
00367|     title: string;
00368|     metadata: {
00369|         [key: string]: unknown;
00370|     };
00371|     time: {
00372|         created: number;
00373|     };
00374| };
00375| export type EventPermissionReplied = {
00376|     type: "permission.replied";
00377|     properties: {
00378|         sessionID: string;
00379|         permissionID: string;
00380|         response: string;
00381|     };
00382| };
00383| export type EventFileEdited = {
00384|     type: "file.edited";
00385|     properties: {
00386|         file: string;
00387|     };
00388| };
00389| export type EventSessionUpdated = {
00390|     type: "session.updated";
00391|     properties: {
00392|         info: Session;
00393|     };
00394| };
00395| export type Session = {
00396|     id: string;
00397|     parentID?: string;
00398|     share?: {
00399|         url: string;
00400|     };
00401|     title: string;
00402|     version: string;
00403|     time: {
00404|         created: number;
00405|         updated: number;
00406|     };
00407|     revert?: {
00408|         messageID: string;
00409|         partID?: string;
00410|         snapshot?: string;
00411|         diff?: string;
00412|     };
00413| };
00414| export type EventSessionDeleted = {
00415|     type: "session.deleted";
00416|     properties: {
00417|         info: Session;
00418|     };
00419| };
00420| export type EventSessionIdle = {
00421|     type: "session.idle";
00422|     properties: {
00423|         sessionID: string;
00424|     };
00425| };
00426| export type EventSessionError = {
00427|     type: "session.error";
00428|     properties: {
00429|         sessionID?: string;
00430|         error?: ({
00431|             name: "ProviderAuthError";
00432|         } & ProviderAuthError) | ({
00433|             name: "UnknownError";
00434|         } & UnknownError) | ({
00435|             name: "MessageOutputLengthError";
00436|         } & MessageOutputLengthError) | ({
00437|             name: "MessageAbortedError";
00438|         } & MessageAbortedError);
00439|     };
00440| };
00441| export type EventServerConnected = {
00442|     type: "server.connected";
00443|     properties: {
00444|         [key: string]: unknown;
00445|     };
00446| };
00447| export type EventFileWatcherUpdated = {
00448|     type: "file.watcher.updated";
00449|     properties: {
00450|         file: string;
00451|         event: "rename" | "change";
00452|     };
00453| };
00454| export type EventIdeInstalled = {
00455|     type: "ide.installed";
00456|     properties: {
00457|         ide: string;
00458|     };
00459| };
00460| export type App = {
00461|     hostname: string;
00462|     git: boolean;
00463|     path: {
00464|         config: string;
00465|         data: string;
00466|         root: string;
00467|         cwd: string;
00468|         state: string;
00469|     };
00470|     time: {
00471|         initialized?: number;
00472|     };
00473| };
00474| export type Config = {
00475|     /**
00476|      * JSON schema reference for configuration validation
00477|      */
00478|     $schema?: string;
00479|     /**
00480|      * Theme name to use for the interface
00481|      */
00482|     theme?: string;
00483|     /**
00484|      * Custom keybind configurations
00485|      */
00486|     keybinds?: KeybindsConfig;
00487|     /**
00488|      * TUI specific settings
00489|      */
00490|     tui?: {
00491|         /**
00492|          * TUI scroll speed
00493|          */
00494|         scroll_speed: number;
00495|     };
00496|     /**
00497|      * Command configuration, see https://opencode.ai/docs/commands
00498|      */
00499|     command?: {
00500|         [key: string]: {

(File has more lines. Use 'offset' parameter to read beyond line 500)
</file>
```

## OpenCode SDK and Plugin SDK Capabilities

Based on the TypeScript definitions, here's what each SDK can do:

### **OpenCode SDK**

The SDK provides a comprehensive client for interacting with OpenCode's server. Main capabilities:

**Core API Classes:**
- **Event**: Subscribe to real-time events
- **App**: Initialize app, get info, write logs, list agents
- **Session**: Create/manage chat sessions, send messages, execute commands
- **Config**: Get configuration and list providers
- **File**: Read files and check status
- **Find**: Search for text, files, and symbols in codebase
- **Command**: List available commands
- **TUI**: Control Terminal UI (prompts, dialogs, toasts)
- **Auth**: Set authentication credentials

**Event Types (Real-time notifications):**
- `installation.updated` - OpenCode version updates
- `lsp.client.diagnostics` - Language server diagnostics
- `message.updated/removed` - Chat message changes
- `message.part.updated/removed` - Message part changes (text, tools, files)
- `storage.write` - Storage updates
- `permission.updated/replied` - Permission request status
- `file.edited` - File modification notifications
- `session.updated/deleted/idle/error` - Session state changes
- `server.connected` - Server connection status
- `file.watcher.updated` - File system changes
- `ide.installed` - IDE integration updates

### **Plugin SDK**

Plugins extend OpenCode with custom functionality through hooks:

**Hook Types:**
- `event` - Handle any SDK event
- `config` - Modify configuration
- `auth` - Add custom authentication providers (OAuth, API keys)
- `chat.message` - Process incoming messages
- `chat.params` - Modify LLM parameters (temperature, topP)
- `permission.ask` - Control permission requests
- `tool.execute.before/after` - Intercept tool executions

**Plugin Input:**
- Access to OpenCode client
- Project information
- Working directory paths
- Shell command execution via Bun

**Message Parts:**
- Text, reasoning, files, tools, steps, snapshots, patches, agents
- Each part has metadata like timing, status, and content

The SDK enables building powerful integrations that can monitor events, modify behavior, add authentication, and extend OpenCode's capabilities through a well-defined plugin system.


*Completed in 42.5s*
