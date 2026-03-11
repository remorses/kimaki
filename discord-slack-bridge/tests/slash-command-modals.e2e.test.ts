// E2E coverage for Slack slash command -> modal -> Discord chat command flow.

import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
} from 'discord-api-types/v10'
import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { sendInteractivePayload, sendSlashCommand } from 'slack-digital-twin/src'
import { setupE2E, teardownE2E, waitFor, type E2EContext } from './e2e-setup.js'

describe('slash command modal flow', () => {
  let ctx: E2EContext
  let applicationId: string

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'commands' }],
      users: [{ name: 'alice', realName: 'Alice' }],
    })
    applicationId = ctx.client.user?.id ?? ''
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('slash command opens modal with autocomplete + select fields and emits interaction on submit', async () => {
    const putResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/guilds/${ctx.twin.workspaceId}/commands`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          {
            name: 'new-session',
            description: 'Start a new session',
            type: ApplicationCommandType.ChatInput,
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'prompt',
                description: 'Prompt content',
                required: true,
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'agent',
                description: 'Agent to use',
                required: false,
                autocomplete: true,
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'scope',
                description: 'Scope',
                required: false,
                choices: [
                  { name: 'Session', value: 'session' },
                  { name: 'Channel', value: 'channel' },
                ],
              },
            ],
          },
        ]),
      },
    )
    expect(putResponse.status).toBe(200)

    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    ctx.twin.clearOpenedViews()

    let receivedInteraction: ChatInputCommandInteraction | undefined
    const onInteraction = (interaction: Interaction): void => {
      if (!interaction.isChatInputCommand()) {
        return
      }
      if (interaction.commandName !== 'new-session') {
        return
      }
      receivedInteraction = interaction
      void interaction.reply({
        content: [
          interaction.options.getString('prompt') ?? '',
          interaction.options.getString('agent') ?? '',
          interaction.options.getString('scope') ?? '',
        ].join('|'),
      })
    }
    ctx.client.on('interactionCreate', onInteraction)

    const slashResponse = await sendSlashCommand({
      config: webhookConfig,
      command: '/new-session',
      text: 'ignored command text',
      userId: ctx.twin.resolveUserId('alice'),
      userName: 'alice',
      channelId: ctx.twin.resolveChannelId('commands'),
      channelName: 'commands',
      triggerId: 'trigger-new-session',
    })
    expect(slashResponse.status).toBe(200)

    const openedView = await ctx.twin.waitForOpenedView({
      predicate: (view) => {
        const callbackId = view.view?.['callback_id']
        return callbackId === 'new-session'
      },
    })

    expect(openedView).toMatchInlineSnapshot(`
      {
        "trigger_id": "trigger-new-session",
        "view": {
          "blocks": [
            {
              "block_id": "prompt",
              "element": {
                "action_id": "prompt",
                "multiline": false,
                "placeholder": {
                  "text": "prompt",
                  "type": "plain_text",
                },
                "type": "plain_text_input",
              },
              "label": {
                "text": "Prompt content",
                "type": "plain_text",
              },
              "optional": false,
              "type": "input",
            },
            {
              "block_id": "agent",
              "element": {
                "action_id": "agent",
                "min_query_length": 1,
                "placeholder": {
                  "text": "agent",
                  "type": "plain_text",
                },
                "type": "external_select",
              },
              "label": {
                "text": "Agent to use",
                "type": "plain_text",
              },
              "optional": true,
              "type": "input",
            },
            {
              "block_id": "scope",
              "element": {
                "action_id": "scope",
                "options": [
                  {
                    "text": {
                      "text": "Session",
                      "type": "plain_text",
                    },
                    "value": "session",
                  },
                  {
                    "text": {
                      "text": "Channel",
                      "type": "plain_text",
                    },
                    "value": "channel",
                  },
                ],
                "placeholder": {
                  "text": "scope",
                  "type": "plain_text",
                },
                "type": "static_select",
              },
              "label": {
                "text": "Scope",
                "type": "plain_text",
              },
              "optional": true,
              "type": "input",
            },
          ],
          "callback_id": "new-session",
          "close": {
            "text": "Cancel",
            "type": "plain_text",
          },
          "private_metadata": "{"commandName":"new-session","channelId":"C000000001","options":[{"name":"prompt","type":3},{"name":"agent","type":3},{"name":"scope","type":3}]}",
          "submit": {
            "text": "Run",
            "type": "plain_text",
          },
          "title": {
            "text": "new-session",
            "type": "plain_text",
          },
          "type": "modal",
        },
      }
    `)

    expect(receivedInteraction).toBeUndefined()

    const callbackId = openedView.view?.['callback_id']
    expect(typeof callbackId).toBe('string')
    if (typeof callbackId !== 'string') {
      return
    }

    const privateMetadata = openedView.view?.['private_metadata']

    const submitResponse = await sendInteractivePayload({
      config: webhookConfig,
      payload: {
        type: 'view_submission',
        trigger_id: 'trigger-new-session-submit',
        team: { id: ctx.twin.workspaceId },
        user: {
          id: ctx.twin.resolveUserId('alice'),
          username: 'alice',
          name: 'alice',
        },
        view: {
          id: 'V_NEW_SESSION',
          callback_id: callbackId,
          private_metadata:
            typeof privateMetadata === 'string' ? privateMetadata : undefined,
          state: {
            values: {
              prompt: {
                prompt: { value: 'Build the command bridge' },
              },
              agent: {
                agent: {
                  selected_option: { value: 'plan' },
                },
              },
              scope: {
                scope: {
                  selected_option: { value: 'session' },
                },
              },
            },
          },
        },
      },
    })
    expect(submitResponse.status).toBe(200)

    const interaction = await waitFor({
      fn: async () => {
        return receivedInteraction
      },
      label: 'slash modal submit interaction',
    })

    ctx.client.off('interactionCreate', onInteraction)

    expect({
      commandName: interaction.commandName,
      prompt: interaction.options.getString('prompt'),
      agent: interaction.options.getString('agent'),
      scope: interaction.options.getString('scope'),
    }).toMatchInlineSnapshot(`
      {
        "agent": "plan",
        "commandName": "new-session",
        "prompt": "Build the command bridge",
        "scope": "session",
      }
    `)

    await waitFor({
      fn: async () => {
        const text = await ctx.twin.channel('commands').text()
        return text.includes('test-bot: Build the command bridge|plan|session')
          ? text
          : undefined
      },
      label: 'command reply posted to slack',
    })
  })

  test('block_suggestion routes through discord autocomplete and returns slack options', async () => {
    const putResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/guilds/${ctx.twin.workspaceId}/commands`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          {
            name: 'new-worktree',
            description: 'Create a worktree',
            type: ApplicationCommandType.ChatInput,
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: 'name',
                description: 'Worktree name',
                required: false,
              },
              {
                type: ApplicationCommandOptionType.String,
                name: 'base-branch',
                description: 'Base branch',
                required: false,
                autocomplete: true,
              },
            ],
          },
        ]),
      },
    )
    expect(putResponse.status).toBe(200)

    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    ctx.twin.clearOpenedViews()

    const slashResponse = await sendSlashCommand({
      config: webhookConfig,
      command: '/new-worktree',
      text: '',
      userId: ctx.twin.resolveUserId('alice'),
      userName: 'alice',
      channelId: ctx.twin.resolveChannelId('commands'),
      channelName: 'commands',
      triggerId: 'trigger-new-worktree',
    })
    expect(slashResponse.status).toBe(200)

    const openedView = await ctx.twin.waitForOpenedView({
      predicate: (view) => {
        const callbackId = view.view?.['callback_id']
        return callbackId === 'new-worktree'
      },
    })

    const privateMetadata = openedView.view?.['private_metadata']

    let autocompleteInteraction: AutocompleteInteraction | undefined
    const onInteraction = (interaction: Interaction): void => {
      if (!interaction.isAutocomplete()) {
        return
      }
      if (interaction.commandName !== 'new-worktree') {
        return
      }
      autocompleteInteraction = interaction
      void interaction.respond([
        { name: 'main', value: 'main' },
        { name: 'develop', value: 'develop' },
      ])
    }
    ctx.client.on('interactionCreate', onInteraction)

    const suggestionResponse = await sendInteractivePayload({
      config: webhookConfig,
      payload: {
        type: 'block_suggestion',
        team: { id: ctx.twin.workspaceId },
        user: {
          id: ctx.twin.resolveUserId('alice'),
          username: 'alice',
          name: 'alice',
        },
        channel: { id: ctx.twin.resolveChannelId('commands') },
        action_id: 'base-branch',
        value: 'ma',
        view: {
          id: 'V_NEW_WORKTREE',
          callback_id: 'new-worktree',
          private_metadata:
            typeof privateMetadata === 'string' ? privateMetadata : undefined,
        },
      },
    })

    const responseData = await suggestionResponse.json()
    expect(suggestionResponse.status).toBe(200)

    const interaction = await waitFor({
      fn: async () => {
        return autocompleteInteraction
      },
      label: 'autocomplete interaction',
    })

    ctx.client.off('interactionCreate', onInteraction)

    expect({
      commandName: interaction.commandName,
      focused: interaction.options.getFocused(true),
      responseData,
    }).toMatchInlineSnapshot(`
      {
        "commandName": "new-worktree",
        "focused": {
          "focused": true,
          "name": "base-branch",
          "type": 3,
          "value": "ma",
        },
        "responseData": {
          "options": [
            {
              "text": {
                "text": "main",
                "type": "plain_text",
              },
              "value": "main",
            },
            {
              "text": {
                "text": "develop",
                "type": "plain_text",
              },
              "value": "develop",
            },
          ],
        },
      }
    `)
  })
})
