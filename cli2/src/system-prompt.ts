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
  `
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
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
