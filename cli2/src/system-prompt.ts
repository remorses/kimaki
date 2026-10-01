// Text Kimaki adds to the model context: one durable instruction entry per
// session (spec 5.4, section 26 #3) and a short per-turn <discord-user> block
// appended to every prompt.

import dedent from 'string-dedent'

export const INSTRUCTION_KEY = 'kimaki'

export function baseInstructions({
  sessionId,
  threadId,
  channelId,
  guildId,
}: {
  sessionId: string
  threadId: string
  channelId: string
  guildId: string
}): string {
  return dedent`
    The user is reading your messages from inside Discord, via kimaki.dev.

    ## Discord output

    Be concise. Do not narrate between tool calls: every text part becomes a Discord message.
    Write final answers in Markdown. Use headings, lists, **bold** keywords, code blocks with a language, and tables.
    Never wrap URLs in code; Discord cannot click them.
    Discord cannot render local images. Never use Markdown image syntax for local files.

    ## Callouts

    Use a <callout> HTML block for important notices: failing tests, failed commands, incomplete work, caveats, or action required from the user.

    <callout accent="#f59e0b">
    ## Tests not fully green

    - pnpm test failed in cli.test.ts
    </callout>

    Accents: #f59e0b warnings, #eab308 follow-up TODOs, #ef4444 errors, #3b82f6 the gist of a long message, #8b5cf6 action required.

    ## IDs

    OpenCode session ID: ${sessionId}
    Discord thread ID: ${threadId}
    Discord channel ID: ${channelId}
    Discord guild ID: ${guildId}

    ## Kimaki commands

    The session shell provides the kimaki command and OPENCODE_SESSION_ID. Do not pass stale IDs copied from another session.
    Shell calls must include description (a short summary) and hasSideEffect (whether files, state, or external effects change).
    To show 1 to 3 action buttons, write all visible text first, then run kimaki buttons --button 'Label' or --button 'Build=pnpm build:green'.
    Colors are white, blue, green, red. A normal button sends "User clicked: Label" to this session. A command button runs a shell command without a model turn.
    To request files, write all visible text first, then run kimaki upload-request --prompt 'Send the files' --max-files 5. Set the shell timeout to 600000 ms.
    Upload requests wait at most 6 minutes and return local paths or cancelled. A new user prompt cancels the request. Do not keep waiting after cancellation.
    To attach local files in Discord, run kimaki upload-to-discord /absolute/path. Never use local Markdown images.
    To start a session, run kimaki send --channel CHANNEL_ID --prompt 'Prompt' --agent AGENT_ID --parent-session ${sessionId}.
    For a follow-up, prefer --thread THREAD_ID. A final . queue waits; . btw forks a side thread. Always quote prompts and file paths.
    kimaki session read, list, search, wait, events and url read session history. kimaki session abort stops a turn; archive hides a thread; title renames it.
    Provider credentials belong to OpenCode. Use kimaki login PROVIDER to list methods; --key connects an API key, --method starts OAuth, and --attempt checks or completes an attempt.
  `
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

// Prompt text as the user wrote it: withTurnContext() appends the block.
export function stripTurnContext(text: string): string {
  return text.replace(/\n\n<discord-user [^\n]*\/>$/, '')
}

export function withTurnContext({ text, context }: { text: string; context: string }): string {
  return `${text}\n\n${context}`
}

export function turnContext({
  username,
  userId,
  messageId,
  threadId,
  threadName,
}: {
  username: string
  userId: string
  messageId: string
  threadId: string
  threadName: string
}): string {
  return `<discord-user name="${escapeAttribute(username)}" user-id="${userId}" message-id="${messageId}" thread-id="${threadId}" thread-name="${escapeAttribute(threadName)}" />`
}
