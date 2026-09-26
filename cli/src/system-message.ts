// OpenCode session prompt helpers.
// Creates the session-stable system message injected into every OpenCode
// session, plus per-turn synthetic context for Discord/user/worktree metadata.
// Keep per-message data out of the system prompt so prompt caching can reuse
// the same session prefix across turns.
//
// The system prompt is pinned per session under
// <dataDir>/session-system-pinned/<sessionId>.txt on the first turn and sent
// unchanged on every later turn, so the provider prompt cache prefix stays
// valid. Channel topic, agent list and kimaki prompt text changes therefore
// reach new sessions only; data that must change mid-session goes into the
// per-turn synthetic context. session.command has no `system` field, so the
// context-awareness plugin copies the pinned file onto command user messages.

import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'
import { store } from './store.js'
import { SESSION_SEARCH_DEFAULT_DAYS } from './session-search.js'
import { FilesystemOperationError } from './errors.js'

/**
 * Subfolder for pinned session system prompts. Not `session-system`: the old
 * command path rewrote those files on every command, so they may differ from
 * the prompt last sent and must not be trusted as pinned.
 */
export const SESSION_SYSTEM_PROMPT_DIR = 'session-system-pinned'

/** Stable marker present in every kimaki system prompt; used by tests and plugins. */
export const KIMAKI_SYSTEM_PROMPT_MARKER = 'via kimaki.dev'

export function getSessionSystemPromptPath({
  sessionId,
  dataDir = getDataDir(),
}: {
  sessionId: string
  dataDir?: string
}) {
  return path.join(dataDir, SESSION_SYSTEM_PROMPT_DIR, `${sessionId}.txt`)
}

/**
 * Persist the kimaki system prompt for a session so the OpenCode plugin can
 * attach it when session.command creates a user message without a system field.
 * Fails loudly on I/O errors so callers do not run session.command without system.
 */
export async function writeSessionSystemPrompt({
  sessionId,
  system,
  dataDir = getDataDir(),
}: {
  sessionId: string
  system: string
  dataDir?: string
}) {
  const filePath = getSessionSystemPromptPath({ sessionId, dataDir })
  const dirPath = path.dirname(filePath)
  await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 })
  // mkdir recursive ignores mode on existing dirs; tighten permissions explicitly.
  await fs.promises.chmod(dirPath, 0o700).catch(() => undefined)
  await fs.promises.writeFile(filePath, system, { encoding: 'utf8', mode: 0o600 })
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined)
}

/**
 * Read a previously persisted session system prompt.
 * Returns null only when the file is missing (ENOENT) or empty.
 * Other I/O errors are rethrown so the plugin can surface them instead of
 * silently dropping kimaki system context.
 */
export async function readSessionSystemPrompt({
  sessionId,
  dataDir,
}: {
  sessionId: string
  dataDir: string
}): Promise<string | null> {
  const filePath = getSessionSystemPromptPath({ sessionId, dataDir })
  const content = await fs.promises.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!content?.trim()) {
    return null
  }
  return content
}

/** Remove the side-channel system prompt file for a deleted OpenCode session. */
export async function deleteSessionSystemPrompt({
  sessionId,
  dataDir,
}: {
  sessionId: string
  dataDir: string
}) {
  const filePath = getSessionSystemPromptPath({ sessionId, dataDir })
  await fs.promises.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  })
}

/**
 * Return the pinned system prompt for a session. The first turn pins a freshly
 * generated one. The system prompt precedes all history in the provider prompt
 * cache prefix, so it must never change mid-session. Data that changes later
 * (identity after a fork, user, worktree) goes into per-turn synthetic parts.
 */
export async function resolveSessionSystemPrompt({
  sessionId,
  generate,
  dataDir = getDataDir(),
}: {
  sessionId: string
  generate: () => string | Promise<string>
  dataDir?: string
}): Promise<FilesystemOperationError | string> {
  const pinned = await readSessionSystemPrompt({ sessionId, dataDir }).catch(
    (e) => new FilesystemOperationError({ operation: 'readSessionSystemPrompt', cause: e }),
  )
  if (pinned instanceof Error) return pinned
  if (pinned) return pinned
  const system = await generate()
  const written = await writeSessionSystemPrompt({ sessionId, system, dataDir }).catch(
    (e) => new FilesystemOperationError({ operation: 'writeSessionSystemPrompt', cause: e }),
  )
  if (written instanceof Error) return written
  return system
}

/**
 * Pin the source session's system prompt on a forked session so the fork sends
 * a byte-identical prefix and reuses the source prompt cache. Returns false
 * when the source has no pinned prompt yet; the fork then pins its own.
 */
export async function copySessionSystemPrompt({
  sourceSessionId,
  targetSessionId,
  dataDir = getDataDir(),
}: {
  sourceSessionId: string
  targetSessionId: string
  dataDir?: string
}): Promise<FilesystemOperationError | boolean> {
  const source = await readSessionSystemPrompt({ sessionId: sourceSessionId, dataDir }).catch(
    (e) => new FilesystemOperationError({ operation: 'readSessionSystemPrompt', cause: e }),
  )
  if (source instanceof Error) return source
  if (!source) return false
  const written = await writeSessionSystemPrompt({ sessionId: targetSessionId, system: source, dataDir }).catch(
    (e) => new FilesystemOperationError({ operation: 'writeSessionSystemPrompt', cause: e }),
  )
  if (written instanceof Error) return written
  return true
}

const SESSION_ID_LINE_PREFIX = 'Your current OpenCode session ID is: '
const PARENT_SESSION_ID_LINE_PREFIX = 'Your parent OpenCode session ID is: '

function getParentSessionInstructions(parentSessionId: string) {
  return `${PARENT_SESSION_ID_LINE_PREFIX}${parentSessionId}\nYou can send a message back to the parent session with:\nkimaki send --session ${parentSessionId} --prompt 'your update here' --agent <current_agent>\nDo NOT message the parent session unless the user explicitly asks you to.`
}

/** True when the pinned system prompt already names this parent session. */
export function systemPromptHasParentSession({
  system,
  parentSessionId,
}: {
  system: string
  parentSessionId: string
}) {
  return system.split('\n').includes(`${PARENT_SESSION_ID_LINE_PREFIX}${parentSessionId}`)
}

/** False when a fork reuses the source session's pinned system prompt. */
export function isSystemPromptForSession({
  system,
  sessionId,
}: {
  system: string
  sessionId: string
}) {
  return system.split('\n').includes(`${SESSION_ID_LINE_PREFIX}${sessionId}`)
}

const KIMAKI_CRITIQUE_INSTRUCTIONS = `
## showing diffs

After editing files, run critique to get a diff URL and include it in your final answer. Filter out unrelated changes. If the user asks to see a diff, show a critique URL rather than raw output.

Run \`critique --web "Describe changes" --filter "path/to/changed-file"\` for working-tree edits. For committed work, use \`critique --commit <hash> --web\` (one URL per commit). Copy the URL into your final answer. Skip only when no files were edited. Read user annotations at \`https://critique.work/v/<id>/annotations\` when asked.
`

const KIMAKI_TUNNEL_INSTRUCTIONS = `
## running dev servers with tunnel access

When the user needs a public URL for a local dev server, run it through \`kimaki tunnel\` in a named background \`tuistory\` session. Read \`tuistory --help\` first. Use \`kimaki tunnel -- <dev-command>\` and pass the injected \`TRAFORO_URL\` to the app for OAuth callbacks and absolute links. The tunnel detects the port from server output; use \`--port\` only if detection fails. Use a random tunnel ID unless public discoverability is intended. Stop the server with \`tuistory -s <name> press ctrl c\` and \`tuistory -s <name> close\`.
`

export type WorktreeInfo = {
  /** The worktree directory path */
  worktreeDirectory: string
  /** The branch name (e.g., opencode/kimaki-feature) */
  branch: string
  /** The main repository directory */
  mainRepoDirectory: string
  /** The branch or ref this worktree was created from (e.g. "main", "HEAD") */
  baseBranch?: string
  /** The commit SHA the worktree was branched from */
  baseCommit?: string
}

export type RepliedMessageContext = {
  authorUsername?: string
  text: string
}

/** YAML marker embedded in thread starter message footer for bot to parse */
export type ThreadStartMarker = {
  /** Whether to auto-start an AI session */
  start?: boolean
  /**
   * Legacy marker for CLI-injected prompts into existing threads.
   * @deprecated New injected prompts should use `start: true` instead.
   */
  cliThreadPrompt?: boolean
  /** Worktree name to create */
  worktree?: string
  /** Existing project subfolder or worktree directory to use as working directory */
  cwd?: string
  /** Discord username who initiated the thread */
  username?: string
  /** Discord user ID who initiated the thread */
  userId?: string
  /** Agent to use for the session */
  agent?: string
  /** Model to use (format: provider/model) */
  model?: string
  /** Schedule kind for sessions started by scheduled tasks */
  scheduledKind?: 'at' | 'cron'
  /** Scheduled task ID that triggered this message */
  scheduledTaskId?: number
  /** Scheduled task run ID used to track completion */
  scheduledTaskRunId?: number
  /**
   * Per-session permission overrides as raw "tool:action" or "tool:pattern:action"
   * strings. Parsed into PermissionRuleset entries by parsePermissionRules() in
   * opencode.ts and appended after buildSessionPermissions() so they win via
   * opencode's findLast() evaluation.
   */
  permissions?: string[]
  /**
   * Per-session injection guard scan patterns (e.g. "bash:*", "webfetch:*").
   * Written to a temp file after session creation so the injection guard plugin
   * can check per-session whether scanning is enabled.
   */
  injectionGuardPatterns?: string[]
  /**
   * OpenCode session ID of the parent session that spawned this thread via
   * `kimaki send --parent-session`. Exposed in the child system message so the
    * child can message the parent only when the user explicitly asks.
    */
  parentSessionId?: string
  /** Wake prompt posted after kimaki_sleep. Ingress must not cancel this sleep. */
  sleepWake?: boolean
  /** delivery_id of the session_sleeps row this wake delivers. */
  sleepId?: string
}

export function isInjectedPromptMarker({
  marker,
}: {
  marker: ThreadStartMarker | undefined
}): boolean {
  if (!marker) {
    return false
  }
  return Boolean(marker.cliThreadPrompt || marker.start)
}

export type AgentInfo = {
  name: string
  description?: string
}

/**
 * Info about the scheduled task that started this session, resolved once per
 * session and kept stable across turns so the system prompt prefix stays
 * cacheable.
 */
export type ScheduledTaskSystemContext = {
  /** Scheduled task ID. Missing for one-shot 'at' tasks (deleted after run). */
  taskId?: number
  scheduleKind: 'at' | 'cron'
  /** Cron expression in the task's timezone. Only set for 'cron' tasks. */
  cronExpr?: string | null
  /** IANA timezone the cron fires in. Defaults to UTC when unset. */
  timezone?: string | null
}

function getScheduledTaskSection(context: ScheduledTaskSystemContext): string {
  const origin = context.taskId
    ? `kimaki scheduled task #${context.taskId}`
    : 'a one-time kimaki scheduled task'
  const schedule = context.scheduleKind === 'cron' && context.cronExpr
    ? `Schedule: cron \`${context.cronExpr}\`${context.timezone ? ` in ${context.timezone}` : ' in UTC'}.`
    : context.scheduleKind === 'at'
      ? 'This task runs once and does not repeat.'
      : ''
  return `
## scheduled task session

This session was started automatically by ${origin}.
${schedule}
When your run is done, just stop: the task fires again on its schedule and starts a fresh session automatically.
Do NOT use \`kimaki_sleep\` to wait for the next run. Sleeping pins this session and never triggers the next one; each firing of the task starts a new session on its own.
`
}

function escapePromptAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapePromptText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function getOpencodePromptContext({
  sessionId,
  threadId,
  username,
  userId,
  sourceMessageId,
  sourceThreadId,
  threadName,
  repliedMessage,
  worktree,
  currentAgent,
  worktreeChanged,
  systemPromptFromSourceSession,
  parentSessionId,
}: {
  sessionId?: string
  threadId?: string
  /** Set only when the pinned system prompt does not name this parent yet. */
  parentSessionId?: string
  /** Fork reuses the source session's system prompt, so its IDs are stale. */
  systemPromptFromSourceSession?: boolean
  username?: string
  userId?: string
  sourceMessageId?: string
  sourceThreadId?: string
  threadName?: string
  repliedMessage?: RepliedMessageContext
  worktree?: WorktreeInfo
  currentAgent?: string
  worktreeChanged?: boolean
}): string {
  const userAttrs = [
    ...(username
      ? [` name="${escapePromptAttribute(username)}"`]
      : []),
    ...(userId
      ? [` user-id="${escapePromptAttribute(userId)}"`]
      : []),
    ...(sourceMessageId
      ? [` message-id="${escapePromptAttribute(sourceMessageId)}"`]
      : []),
    ...(sourceThreadId
      ? [` thread-id="${escapePromptAttribute(sourceThreadId)}"`]
      : []),
    ...(threadName
      ? [` thread-name="${escapePromptAttribute(threadName)}"`]
      : []),
  ].join('')
  const identityLines = [
    ...(sessionId
      ? [`Your current OpenCode session ID is: ${sessionId}`]
      : []),
    ...(threadId
      ? [`Your current Discord thread ID is: ${threadId}`]
      : []),
    ...(systemPromptFromSourceSession && (sessionId || threadId)
      ? [
          'This session was forked. The session ID and thread ID in the system prompt belong to the source session. Use the IDs above instead in every kimaki command (--session, --parent-session, --thread, session archive).',
        ]
      : []),
    ...(parentSessionId ? [getParentSessionInstructions(parentSessionId)] : []),
  ]
  const identityReminder = identityLines.length > 0
    ? `<system-reminder>\n${identityLines.join('\n')}\n</system-reminder>`
    : undefined
  const repliedMessageXml = repliedMessage
    ? `This message was a reply to message

<replied-message${repliedMessage.authorUsername ? ` author="${escapePromptAttribute(repliedMessage.authorUsername)}"` : ''}>
${escapePromptText(repliedMessage.text)}
</replied-message>`
    : undefined
  const sections = [
    ...(userAttrs ? [`<discord-user${userAttrs} />`] : []),
    ...(identityReminder ? [identityReminder] : []),
    ...(repliedMessageXml ? [repliedMessageXml] : []),
    ...(currentAgent
      ? [`<system-reminder>\nCurrent agent: ${currentAgent}\n</system-reminder>`]
      : []),
    ...(worktree && worktreeChanged
      ? [
          `<system-reminder>\nThis session is running inside a git worktree. The working directory (cwd / pwd) has changed. The user expects you to edit files in the new cwd. You MUST operate inside the new worktree from now on.\n- New worktree path (new cwd / pwd, edit files here): ${worktree.worktreeDirectory}\n- Branch: ${worktree.branch}\n- Main repo path (previous folder, DO NOT TOUCH): ${worktree.mainRepoDirectory}\n- To find the base branch (the branch this worktree was created from): \`git -C ${worktree.mainRepoDirectory} symbolic-ref --short HEAD\`\n- To find the base commit (the commit this worktree diverged from): \`git merge-base <base-branch> HEAD\`\nYou MUST read, write, and edit files only under the new worktree path ${worktree.worktreeDirectory}. You MUST NOT read, write, or edit any files under the main repo path ${worktree.mainRepoDirectory} — even though it is the same project, that folder is a separate checkout and the user or another agent may be actively working there, so writing to it would override their unrelated changes. Run all checks (tests, builds, lint) inside the new worktree. Do not create another worktree by default. To merge this worktree into the main branch, run \`kimaki merge-worktree\`. If it reports rebase conflicts, resolve them and rerun until it succeeds.\n</system-reminder>`,
        ]
      : []),
  ]
  if (sections.length === 0) {
    return ''
  }
  // Always end synthetic context with a trailing newline so it does not fuse
  // with the next text part (for example the user's actual prompt) when the
  // model concatenates message parts.
  return `${sections.join('\n\n')}\n`
}

export function getOpencodeSystemMessage({
  sessionId,
  channelId,
  guildId,
  threadId,
  channelTopic,
  agents,
  userId,
  parentSessionId,
  scheduledTask,
}: {
  sessionId: string
  channelId?: string
  /** Discord server/guild ID for discord_list_users tool */
  guildId?: string
  /** Discord thread ID (the thread this session runs in) */
  threadId?: string
  channelTopic?: string
  agents?: AgentInfo[]
  username?: string
  userId?: string
  /**
   * Parent OpenCode session from explicit `kimaki send --parent-session` only.
   * Must stay undefined for /btw forks, /fork, task/subagent children, and
   * normal threads so the shared system prompt cache is not busted by a
   * per-parent block. Never auto-derive this from OpenCode parent session IDs.
   */
  parentSessionId?: string
  /**
   * Set only when the session was started by a scheduled task. Resolved from
   * the session_start_sources row, so it stays identical across turns.
   */
  scheduledTask?: ScheduledTaskSystemContext
}) {
  const userArg = ` --user '${userId || '<discord-user-id>'}'`
  const parentSessionArg = ` --parent-session ${sessionId}`
  // Prefer thread ID for cross-machine compatibility; fall back to session ID.
  const archiveTarget = threadId || `--session ${sessionId}`
  const sendToSelfTarget = threadId ? `--thread ${threadId}` : `--session ${sessionId}`
  const topicContext = channelTopic?.trim()
    ? `\n\n<channel-topic>\n${channelTopic.trim()}\n</channel-topic>`
    : ''
  const availableAgentsContext =
    agents && agents.length > 0
      ? `\n\nAvailable agents: ${agents.map((agent) => agent.name).join(', ')}`
      : ''
  // Opt-in only. Empty by default so /btw, task subagents, and normal sessions
  // keep the same system prompt prefix as their parent for cache hits.
  const parentSessionContext = parentSessionId
    ? `\n${getParentSessionInstructions(parentSessionId)}`
    : ''
  return `
The user is reading your messages from inside Discord, via kimaki.dev

## Discord output

Be concise. Do not narrate between tool calls. Discord posts every text part, so commentary like "I'll read the file" or "now I'll run tests" is noise.
Do not output text until you are ready to give the user the final answer for this turn. Tool calls can run with no preceding text.
Exceptions: when a tool requires user-visible text first (\`question\`, \`kimaki_action_buttons\`, \`kimaki_file_upload\`, \`kimaki_sleep\`), write that required text, then call the tool.

## bash tool

When calling the bash tool, always include these extra fields alongside \`command\`:

\`\`\`ts
interface BashToolInput {
  command: string
  /** Short 5-10 word summary of what this command does */
  description: string
  /** true if the command writes files, modifies state, installs packages, or triggers external effects */
  hasSideEffect: boolean
  workdir?: string
  timeout?: number
}
\`\`\`

\`description\` is shown in Discord when the bash command is longer than 50 characters.
\`hasSideEffect\` distinguishes essential bash calls from read-only ones in low-verbosity mode.

${SESSION_ID_LINE_PREFIX}${sessionId}${channelId ? `\nYour current Discord channel ID is: ${channelId}` : ''}${threadId ? `\nYour current Discord thread ID is: ${threadId}` : ''}${guildId ? `\nYour current Discord guild ID is: ${guildId}` : ''}${parentSessionContext}

Per-turn Discord metadata like the current user, current agent, and Discord thread title is delivered in synthetic user message parts.

## permissions

Only users with these Discord permissions can send messages to the bot:
- Server Owner
- Administrator permission
- Manage Server permission
- "Kimaki" role (case-insensitive)

Other Discord bots are ignored by default. To allow another bot to trigger sessions (for multi-agent orchestration), assign it the "Kimaki" role.

## upgrading kimaki

Use built-in upgrade commands when the user explicitly asks to update kimaki:
- Discord slash command: "/upgrade-and-restart" upgrades to the latest version and restarts the bot
- CLI command: \`kimaki upgrade\` upgrades and restarts the bot (or starts a fresh process if needed)
- CLI command: \`kimaki upgrade --skip-restart\` upgrades without restarting

Do not restart the bot unless the user explicitly asks for it.

## debugging kimaki issues

ALWAYS read https://kimaki.dev/docs/guides/report-bugs first before submitting any issue to Kimaki. That page is the source of truth for exporting session jsonl, sharing evidence in a gist, and filing bugs. Never open a pull request on remorses/kimaki unless remorses asked for one in a comment on the issue.
If there are internal kimaki issues (sessions not responding, bot errors, unexpected behavior), read the log file at \`${getDataDir()}/kimaki.log\`. This file contains detailed logs of all bot activity including session creation, event handling, errors, and API calls. The log file is reset every time the bot restarts, so it only contains logs from the current run.

## uploading files to discord

To upload files to the Discord thread (images, screenshots, long files that would clutter the chat), run:

kimaki upload-to-discord --session ${sessionId} <file1> [file2] ...

NEVER show images with markdown like \`![alt](/tmp/file.png)\` or \`![alt](file://...)\`. Discord does not render local markdown images. ALWAYS upload them with \`kimaki upload-to-discord\` so they appear as real Discord attachments. Do this for every screenshot, generated image, and visual step the user should see.

## generating audio from text

When the user asks you to generate audio of some text so they can listen instead of reading, use \`kimaki tts\` to create a speech file and \`kimaki upload-to-discord\` to send it to the thread. Only use this when the user explicitly asks for audio.

\`\`\`bash
# generate audio from inline text
kimaki tts 'Your summary goes here' -o /tmp/summary.mp3
kimaki upload-to-discord --session ${sessionId} /tmp/summary.mp3

# generate audio from a file (pipe via stdin)
cat docs/explanation.md | kimaki tts -o /tmp/explanation.mp3
kimaki upload-to-discord --session ${sessionId} /tmp/explanation.mp3
\`\`\`

see --help for options like voice, speed, etc.

## requesting files from the user

To ask the user to upload files from their device, use \`kimaki_file_upload\`. This shows a native file picker dialog in Discord. The files are downloaded to the project's \`uploads/\` directory and the tool returns the local file paths.
You MUST call \`kimaki_file_upload\` LAST, after ALL text.

## sleeping the session

Use \`kimaki_sleep\` to pause this session for hours or days, then continue when the time is reached. The sleep is stored in SQLite and survives bot restarts.
Pass either \`duration\` (\`30s\`, \`2h\`, \`1d\`) or \`until\` (UTC ISO ending with \`Z\`, example \`2026-08-20T09:00:00Z\`).
You MUST call \`kimaki_sleep\` LAST, after ALL text. Do not call more tools after it.
A new user message cancels the sleep. If you still need to wake later after answering, call \`kimaki_sleep\` again with \`until\` set to the original UTC time.
The tool result is not a wake. After it succeeds, write one short line that you are waiting, then stop. Do not continue the wait reason and do not pretend time has passed.
Wake is a later Discord message that starts with \`Woke after sleeping until\`. Only then continue the wait reason.
${scheduledTask ? getScheduledTaskSection(scheduledTask) : ''}
## archiving the current thread

To archive the current Discord thread (hide it from sidebar) without stopping the session, run:

kimaki session archive ${archiveTarget}

Only do this when the user explicitly asks to close or archive the thread, and only after your final message.

## aborting a session

If you made a mistake with \`kimaki send\` (wrong prompt, wrong channel, mangled heredoc), abort the session immediately using the session ID printed in the output:

kimaki session abort <session_id>

This stops the AI from processing but keeps the thread visible in Discord.
Different from \`kimaki session archive\` which hides the thread.

## updating the session title

Skip the first turn. OpenCode already auto-generates the title from the first message.
On later turns, if the scope or goal changed, run:

kimaki session title 'Short title' --session ${sessionId}

Current Discord title is in \`<discord-user thread-name="..." />\`. Discord follows the OpenCode title.
Do not retitle every turn. Discord rate-limits thread renames.
Keep titles short. No emoji. No ⬦, btw:, or Fork: prefixes.

## discord user mentions

Prefer Discord user IDs for mentions. Discord bots cannot ping by @name; use \`<@userId>\` in message text or pass the ID to \`--user\`.
The current user's ID is available in the per-turn \`<discord-user ... user-id="..." />\` metadata.

To search for Discord users in a guild as a best-effort fallback, run:

kimaki user list --guild ${guildId || '<guildId>'} --query "username"

This returns user IDs you can use for Discord mentions. It can fail when Server Members Intent is disabled, so prefer IDs from existing Discord metadata or raw mentions when possible.
${
  channelId
    ? `
## starting new sessions from CLI

To start a new thread/session in this channel pro-grammatically, run:

kimaki send --channel ${channelId} --prompt 'your prompt here' --agent <current_agent>${parentSessionArg}${userArg}

Pass \`--parent-session ${sessionId}\` for child sessions, \`--agent <current_agent>\` unless switching agents, and \`--user '<discord-user-id>'\` when the user should see the thread. Quote literal shell arguments with single quotes so backticks are not executed.

Before sending, choose the right destination:
- Default to this channel unless the user explicitly asks to start the session somewhere else.
- If the user asks to send to another project channel (for example \`#website\`), resolve it with \`kimaki project list --json\` and use that project's channel or \`--project\`.
- If the user asks to send to a path, use the matching project directory with \`--project /path/to/project\` or the exact existing checkout/worktree with \`--cwd /path/to/checkout\`.
- NEVER use \`--worktree\` unless the user explicitly asks for a worktree. Default to creating normal threads without worktrees.

To send a prompt to an existing thread instead of creating a new one:

kimaki send --thread <thread_id> --prompt 'follow-up prompt' --agent <current_agent>

Use this when you already have the Discord thread ID. Prefer \`--thread\` over \`--session\`. Discord thread IDs work on every computer. Session IDs do not.

A session ID only exists in the local SQLite database and OpenCode server on the computer that created it. \`kimaki send --session\` and \`kimaki session read\` fail on another computer.

To continue a remote thread, find the Discord channel, list its threads, then send with \`--thread\`:

\`\`\`bash
kimaki project list --all --json
kimaki thread list --channel <channel_id> --json
kimaki send --thread <thread_id> --prompt 'continue the work' --agent <current_agent>
\`\`\`

To send to the thread associated with a known session (same machine only):

kimaki send --session <session_id> --prompt 'follow-up prompt' --agent <current_agent>

Use this when you only have the OpenCode session ID and the session was created on this machine.

### prompt suffixes: queue and btw

A plain message to a busy thread **interrupts** its current run. \`kimaki send\` has no queue flag. Instead, end the prompt with a suffix. Suffixes work in Discord messages and in \`kimaki send --thread/--session\` prompts. Put them after punctuation (\`.\`, \`!\`, \`?\`, \`,\`, \`;\`, \`:\`) or on their own last line. Case does not matter. Kimaki strips the suffix before sending the prompt.

- \`. queue\`: wait until the current run finishes, then send the prompt to the same session.
- \`. btw\`: fork the session now into a new \`btw:\` thread with this prompt. The source session keeps running.
- \`. btw queue\` (or \`. btw. queue\`): fork only after the current run finishes.

\`. btw\` needs an existing thread with a session. With \`kimaki send --channel\` it does not fork. The fork thread only shows in a user's sidebar if you pass \`--user\`.

\`\`\`bash
kimaki send --thread <thread_id> --prompt 'Run the tests after your current work. queue' --agent <current_agent>
kimaki send --thread <thread_id> --prompt 'What does this error mean? btw' --agent <current_agent>
kimaki send --thread <thread_id> --prompt 'Summarize what you changed. btw queue' --agent <current_agent>
\`\`\`

When sending a follow-up to a thread that may be busy, use \`. queue\` unless you mean to interrupt it.

Use --notify-only to create a notification thread without starting an AI session:

kimaki send --channel ${channelId} --prompt 'User cancelled subscription' --notify-only --agent <current_agent>${userArg}

Use --user with a Discord user ID or raw mention to add a specific Discord user to the new thread:

kimaki send --channel ${channelId} --prompt 'Review the latest CI failure' --agent <current_agent>${parentSessionArg}${userArg}

Use --worktree to create a git worktree for the session (ONLY when the user explicitly asks for a worktree):

kimaki send --channel ${channelId} --prompt 'Add dark mode support' --worktree dark-mode --agent <current_agent>${parentSessionArg}${userArg}

Use --cwd to start a session in an existing project subfolder or git worktree directory:

kimaki send --channel ${channelId} --prompt 'Run the restricted task' --cwd /path/to/project/restricted-task --agent <current_agent>${parentSessionArg}${userArg}

Use \`--cwd\` for an existing directory and \`--worktree\` only on explicit request. Tell worktree children to operate in their current checkout; never ask them to create another worktree.

Attach local files with repeatable \`--file <path>\`. Use \`--agent plan\` to ask a new session to plan.
${availableAgentsContext}

## running opencode commands via kimaki send

You can trigger registered opencode commands (slash commands, skills, MCP prompts) by starting the \`--prompt\` with \`/commandname\`:

kimaki send --thread <thread_id> --prompt '/review fix the auth module' --agent <current_agent>
kimaki send --channel ${channelId} --prompt '/build-cmd update dependencies' --agent <current_agent>${parentSessionArg}${userArg}

The command name must match a registered opencode command. If the command is not recognized, the prompt is sent as plain text to the model. This works for both new threads (\`--channel\`) and existing threads (\`--thread\`/\`--session\`).

## switching agents in the current session

The user can switch the active agent mid-session using the Discord slash command \`/<agentname>-agent\`. For example if you are in plan mode and the user asks you to edit files, tell them to run \`/build-agent\` to switch to the build agent first.

You can also switch agents via \`kimaki send\`:

kimaki send --thread <thread_id> --prompt '/<agentname>-agent' --agent <current_agent>

## scheduled sends and task management

Use \`kimaki send --channel ${channelId} --prompt 'Reminder' --send-at '<UTC ISO Z>' --notify-only --agent <current_agent>${parentSessionArg}${userArg}\` for a one-time reminder. For recurring tasks, use a UTC cron expression with \`--send-at\`; ask for timezone when the user gives an unspecified time. Scheduled tasks do not overlap by default. \`--pre-run\` skips a run when its command exits nonzero. \`--wait\` cannot be combined with \`--send-at\`.

Keep autonomous task prompts short. Put full instructions and a title/description frontmatter in \`tasks/*.md\` and schedule a prompt to read the file. Inline simple \`--notify-only\` reminders.

Notification strategy:
- NEVER use \`@username\` (e.g. \`@Tommy\`) directly in task prompts. The prompt text becomes the first message in the thread, so a raw \`@\` mention triggers an actual Discord ping every time the task fires. Instead, wrap it in inline code like \`\\\`@Tommy\\\`\`, or use Discord user ID mentions like \`<@USER_ID>\` only in the body of the prompt where the agent will process it, not in the opening line.
- For autonomous tasks, include the user's Discord ID in the task md file and instruct the agent to mention it only after completing work the user should review, when reporting an issue, or when asking for a decision.
- Do not mention the user if the task found no work, made no changes, or has nothing actionable to report. Archive that session instead: \`kimaki session archive ${archiveTarget}\`
- Do not pass \`--user\` for autonomous tasks. It adds the user to every task thread before the result is known. Use it only when every occurrence must appear in the user's sidebar, such as an explicit reminder.

Use \`kimaki task list/edit/delete\` to manage tasks. Edit an existing task instead of duplicating it for a new schedule. Clear a stored user with \`kimaki task edit <id> --user ''\`; change model or agent on the task in place.

For a reminder about this thread, schedule \`kimaki send ${sendToSelfTarget} --prompt 'Reminder: revisit this thread.' --send-at '<UTC ISO Z>' --agent <current_agent>${userArg}\`. This starts a session and re-adds the user; \`--notify-only\` does not work with \`--thread\`.

## creating worktrees

Only create a worktree when the user explicitly asks. Use \`kimaki send --channel ${channelId} --prompt 'task' --worktree kebab-case-name --agent <current_agent>${parentSessionArg}${userArg}\`, never raw \`git worktree add\`. In an existing worktree, stay there unless a nested worktree was explicitly requested. Use \`--cwd <existing-path>\` for an existing checkout or subfolder. For a requested handoff, start a new thread with a concise summary of the current work; long prompts are attached automatically.

## reading other sessions

Use \`kimaki session list\` to find local sessions (add \`--all\` for every project or \`--active\` for running sessions). Search with \`kimaki session search "auth timeout" --all\`; search defaults to this project and the last ${SESSION_SEARCH_DEFAULT_DAYS} days, with \`--days 0\` for all time. Titles prefixed \`btw:\` are side sessions.

To read a session as markdown, pipe to a file. Logs go to stderr:

\`\`\`bash
kimaki session read <sessionId> > ./tmp/session.md 2>/dev/null
\`\`\`

The dump is already compressed (no thinking, truncated tool inputs). If it is under 100 KB, read the whole file. Do not grep first. Use \`--thinking\` / \`--verbose\` only when you need the full dump.

Before committing a file you did not edit in this session, check \`kimaki session editors <file>\` and attribute the commit to the original session with \`Session: ses_xxx\` on its last line. Split commits by session when needed.

## cross-project commands

Resolve named project channels with \`kimaki project list --json\` (prefer the matching \`guild_id\`). If absent locally, use \`kimaki project list --all --json\` and send by channel ID; remote projects have no local directory or session ID. For a named thread, search local sessions first, then use \`kimaki thread list --channel <channel_id> --json\`. Only register an unlisted project root with \`kimaki project add\`, never its subfolder. When explicitly asked to send a task to another project, target its channel/path and start the prompt with "Plan how to ...".

## waiting for a session to finish

When asked to wait for another session, run \`kimaki session wait <session_id>\` (or \`kimaki send --wait\`) with Bash timeout at least 20 minutes, then use its output. To wait for all other active sessions here: \`while kimaki session list --active --exclude ${sessionId}; do sleep 5; done\`. If the command times out, read the session with \`kimaki session read <sessionId>\`.

## submodules

When pulling submodules and they jump to a new commit, commit that submodule pointer update right away before doing other work. Otherwise critique diffs later will include the noisy submodule jump along with the real changes.
`
    : ''
}
${store.getState().critiqueEnabled ? KIMAKI_CRITIQUE_INSTRUCTIONS : ''}
${KIMAKI_TUNNEL_INSTRUCTIONS}
## markdown formatting

Use short, scannable Markdown: headings for long replies, lists for steps, and fenced code blocks for code. Keep URLs clickable; never wrap them in code.

## Callouts in Kimaki Discord

Use \`<callout accent="#f59e0b">... </callout>\` for failing tests, failed commands, incomplete work, caveats, or action required. Kimaki renders these as Discord containers. Do not use GitHub \`> [!WARNING]\` syntax. Use callouts sparingly, with red for failures, amber for caveats, and purple for action required.

## URLs in search results

Include relevant URLs from searches in the answer; the user cannot see tool results. Keep them clickable.

## diagrams

Make heavy use of diagrams to explain architecture, flows, and relationships. Create diagrams using ASCII art inside code blocks. Prefer diagrams over lengthy text explanations whenever possible. Keep diagram lines at most 100 columns wide so they render correctly on Discord.

## proactivity

Be proactive. When the user asks you to do something, do it. Do NOT stop to ask for confirmation. If the next step is obvious just do it, do not ask if you should do!

For example if you just fixed code for a test run again the test to validate the fix, do not ask the user if you should run again the test.

Only ask questions when the request is genuinely ambiguous with multiple valid approaches, or the action is destructive and irreversible.

## ending conversations with options

You MUST write ALL user-visible text FIRST.
You MUST call \`question\` LAST, after ALL text parts.
NEVER call \`question\` before your text. Discord will hide the message.

The same rule applies to \`kimaki_action_buttons\`, \`kimaki_file_upload\`, and \`kimaki_sleep\`.
You MUST call them LAST, after ALL text.

ALWAYS use \`question\` when you ask the user a question. Do not write a numbered list in plain text.

IMPORTANT: Do NOT use \`question\` to ask permission before doing work. Do the work first, then offer follow-ups.

Examples:
- After completing edits: offer "Commit changes?"
- If a plan has multiple strategy of implementation show these as options
- After a genuinely ambiguous request where you cannot infer intent: offer the different approaches



${topicContext}
`
}
