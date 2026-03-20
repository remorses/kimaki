// /tasks command — list all scheduled tasks sorted by next run time.
// Renders a markdown table that the CV2 pipeline auto-formats for Discord,
// including HTML-backed action buttons for cancellable tasks.

import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type APITextDisplayComponent,
  type InteractionEditReplyOptions,
} from 'discord.js'
import {
  cancelScheduledTask,
  listScheduledTasks,
  type ScheduledTask,
  type ScheduledTaskStatus,
} from '../database.js'
import { splitTablesFromMarkdown } from '../format-tables.js'
import {
  buildHtmlActionCustomId,
  cancelHtmlActionsForOwner,
  registerHtmlAction,
} from '../html-actions.js'
import { formatTimeAgo } from './worktrees.js'

function formatTimeUntil(date: Date): string {
  const diffMs = date.getTime() - Date.now()
  if (diffMs <= 0) {
    return 'due now'
  }
  const totalSeconds = Math.floor(diffMs / 1000)
  if (totalSeconds < 60) {
    return `in ${totalSeconds}s`
  }
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    return `in ${totalMinutes}m`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) {
    return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `in ${days}d ${remainingHours}h` : `in ${days}d`
}

function scheduleLabel(task: ScheduledTask): string {
  if (task.schedule_kind === 'cron') {
    return task.cron_expr || 'cron'
  }
  return 'one-time'
}

function canCancelTask(task: ScheduledTask): boolean {
  return task.status === 'planned' || task.status === 'running'
}

function buildCancelButtonHtml({ buttonId }: { buttonId: string }): string {
  return `<button id="${buttonId}" variant="secondary">Cancel</button>`
}

function buildActionCell(task: ScheduledTask): string {
  if (!canCancelTask(task)) {
    return '-'
  }
  return buildCancelButtonHtml({ buttonId: `cancel-task-${task.id}` })
}

function buildTaskTable({
  tasks,
  guildId,
}: {
  tasks: ScheduledTask[]
  guildId: string
}): string {
  const header = '| ID | Status | Prompt | Schedule | Next Run | Action |'
  const separator = '|---|---|---|---|---|---|'
  const rows = tasks.map((task) => {
    const id = String(task.id)
    const status = task.status
    // Truncate prompt for table display
    const prompt =
      task.prompt_preview.length > 40
        ? task.prompt_preview.slice(0, 37) + '...'
        : task.prompt_preview
    const schedule = scheduleLabel(task)
    const nextRun = (() => {
      if (
        task.status === 'completed' ||
        task.status === 'cancelled' ||
        task.status === 'failed'
      ) {
        return task.last_run_at ? formatTimeAgo(task.last_run_at) : '-'
      }
      return formatTimeUntil(task.next_run_at)
    })()
    const action = buildActionCell(task)
    return `| ${id} | ${status} | ${prompt} | ${schedule} | ${nextRun} | ${action} |`
  })
  return [header, separator, ...rows].join('\n')
}

function getTasksActionOwnerKey({
  userId,
  channelId,
}: {
  userId: string
  channelId: string
}): string {
  return `tasks:${userId}:${channelId}`
}

type TasksReplyTarget = {
  guildId: string
  userId: string
  channelId: string
  showAll: boolean
  notice?: string
  editReply: (
    options: string | InteractionEditReplyOptions,
  ) => Promise<unknown>
}

async function renderTasksReply({
  guildId,
  userId,
  channelId,
  showAll,
  notice,
  editReply,
}: TasksReplyTarget): Promise<void> {
  const ownerKey = getTasksActionOwnerKey({ userId, channelId })
  cancelHtmlActionsForOwner(ownerKey)

  const statuses: ScheduledTaskStatus[] | undefined = showAll
    ? undefined
    : ['planned', 'running']
  const tasks = await listScheduledTasks({ statuses })
  if (tasks.length === 0) {
    const message = notice
      ? `${notice}\n\nNo scheduled tasks found.`
      : 'No scheduled tasks found.'
    const textDisplay: APITextDisplayComponent = {
      type: ComponentType.TextDisplay,
      content: message,
    }
    await editReply({
      components: [textDisplay],
      flags: MessageFlags.IsComponentsV2,
    })
    return
  }

  const cancellableTasksByButtonId = new Map<string, ScheduledTask>()
  tasks.forEach((task) => {
    if (!canCancelTask(task)) {
      return
    }
    cancellableTasksByButtonId.set(`cancel-task-${task.id}`, task)
  })

  const tableMarkdown = buildTaskTable({ tasks, guildId })
  const markdown = notice ? `${notice}\n\n${tableMarkdown}` : tableMarkdown
  const segments = splitTablesFromMarkdown(markdown, {
    resolveButtonCustomId: ({ button }) => {
      const task = cancellableTasksByButtonId.get(button.id)
      if (!task) {
        return new Error(`No task registered for button ${button.id}`)
      }

      const actionId = registerHtmlAction({
        ownerKey,
        threadId: String(task.id),
        run: async ({ interaction }) => {
          await handleCancelTaskAction({
            interaction,
            taskId: task.id,
            showAll,
          })
        },
      })
      return buildHtmlActionCustomId(actionId)
    },
  })

  const components: APIMessageTopLevelComponent[] = segments.flatMap(
    (segment) => {
      if (segment.type === 'components') {
        return segment.components
      }
      const textDisplay: APITextDisplayComponent = {
        type: ComponentType.TextDisplay,
        content: segment.text,
      }
      return [textDisplay]
    },
  )

  await editReply({
    components,
    flags: MessageFlags.IsComponentsV2,
  })
}

async function handleCancelTaskAction({
  interaction,
  taskId,
  showAll,
}: {
  interaction: ButtonInteraction
  taskId: number
  showAll: boolean
}): Promise<void> {
  const guildId = interaction.guildId
  if (!guildId) {
    await interaction.editReply({
      components: [
        {
          type: ComponentType.TextDisplay,
          content: 'This action can only be used in a server.',
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    })
    return
  }

  const cancelled = await cancelScheduledTask(taskId)
  const notice = cancelled
    ? `Cancelled task #${taskId}.`
    : `Task #${taskId} not found or already finalized.`

  await renderTasksReply({
    guildId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    showAll,
    notice,
    editReply: (options) => {
      return interaction.editReply(options)
    },
  })
}

export async function handleTasksCommand({
  command,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  const guildId = command.guildId
  if (!guildId) {
    await command.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const showAll = command.options.getBoolean('all') ?? false
  await command.deferReply({ flags: MessageFlags.Ephemeral })
  await renderTasksReply({
    guildId,
    userId: command.user.id,
    channelId: command.channelId,
    showAll,
    editReply: (options) => {
      return command.editReply(options)
    },
  })
}
