import { describe, test, expect } from 'vitest'
import { componentsToBlocks } from '../src/component-converter.js'
import { ComponentType, ButtonStyle } from 'discord-api-types/v10'

describe('componentsToBlocks', () => {
  test('returns empty array for no components', () => {
    expect(componentsToBlocks([])).toMatchInlineSnapshot(`[]`)
  })

  test('converts ActionRow with buttons', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Primary,
            label: 'Click me',
            custom_id: 'btn_1',
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Danger,
            label: 'Delete',
            custom_id: 'btn_delete',
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary,
            label: 'Cancel',
            custom_id: 'btn_cancel',
          },
        ],
      },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "elements": [
            {
              "action_id": "btn_1",
              "style": "primary",
              "text": {
                "emoji": true,
                "text": "Click me",
                "type": "plain_text",
              },
              "type": "button",
              "value": "btn_1",
            },
            {
              "action_id": "btn_delete",
              "style": "danger",
              "text": {
                "emoji": true,
                "text": "Delete",
                "type": "plain_text",
              },
              "type": "button",
              "value": "btn_delete",
            },
            {
              "action_id": "btn_cancel",
              "style": undefined,
              "text": {
                "emoji": true,
                "text": "Cancel",
                "type": "plain_text",
              },
              "type": "button",
              "value": "btn_cancel",
            },
          ],
          "type": "actions",
        },
      ]
    `)
  })

  test('converts link button with URL', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Link,
            label: 'Open docs',
            url: 'https://example.com/docs',
          },
        ],
      },
    ]

    const blocks = componentsToBlocks(components)
    expect(blocks[0]!.elements).toMatchInlineSnapshot(`
      [
        {
          "action_id": "link_de106e607d0e711199de3fb7eb98fe5d",
          "text": {
            "emoji": true,
            "text": "Open docs",
            "type": "plain_text",
          },
          "type": "button",
          "url": "https://example.com/docs",
        },
      ]
    `)
  })

  test('converts StringSelect', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: 'model_select',
            placeholder: 'Choose a model',
            options: [
              { label: 'GPT-4', value: 'gpt-4', description: 'Most capable' },
              { label: 'Claude', value: 'claude', default: true },
            ],
          },
        ],
      },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "elements": [
            {
              "action_id": "dsbcmp:3:model_select",
              "initial_option": {
                "text": {
                  "emoji": true,
                  "text": "Claude",
                  "type": "plain_text",
                },
                "value": "claude",
              },
              "options": [
                {
                  "description": {
                    "text": "Most capable",
                    "type": "plain_text",
                  },
                  "text": {
                    "emoji": true,
                    "text": "GPT-4",
                    "type": "plain_text",
                  },
                  "value": "gpt-4",
                },
                {
                  "text": {
                    "emoji": true,
                    "text": "Claude",
                    "type": "plain_text",
                  },
                  "value": "claude",
                },
              ],
              "placeholder": {
                "text": "Choose a model",
                "type": "plain_text",
              },
              "type": "static_select",
            },
          ],
          "type": "actions",
        },
      ]
    `)
  })

  test('converts UserSelect', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.UserSelect,
            custom_id: 'assignee_select',
            placeholder: 'Pick user',
            max_values: 1,
          },
        ],
      },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "elements": [
            {
              "action_id": "dsbcmp:5:assignee_select",
              "placeholder": {
                "text": "Pick user",
                "type": "plain_text",
              },
              "type": "users_select",
            },
          ],
          "type": "actions",
        },
      ]
    `)
  })

  test('converts ChannelSelect', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.ChannelSelect,
            custom_id: 'channel_select',
            max_values: 2,
          },
        ],
      },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "elements": [
            {
              "action_id": "dsbcmp:8:channel_select",
              "filter": {
                "exclude_bot_users": true,
                "exclude_external_shared_channels": false,
                "include": [
                  "public",
                  "private",
                ],
              },
              "max_selected_items": 2,
              "type": "multi_conversations_select",
            },
          ],
          "type": "actions",
        },
      ]
    `)
  })

  test('converts MentionableSelect to users select', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.MentionableSelect,
            custom_id: 'mentionable_select',
          },
        ],
      },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "elements": [
            {
              "action_id": "dsbcmp:7:mentionable_select",
              "type": "users_select",
            },
          ],
          "type": "actions",
        },
      ]
    `)
  })

  test('converts RoleSelect with fallback option', () => {
    const components = [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.RoleSelect,
            custom_id: 'role_select',
          },
        ],
      },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "elements": [
            {
              "action_id": "dsbcmp:6:role_select",
              "initial_option": {
                "description": {
                  "text": "Slack has no role picker; this bridge uses role IDs when available.",
                  "type": "plain_text",
                },
                "text": {
                  "emoji": true,
                  "text": "No roles available",
                  "type": "plain_text",
                },
                "value": "__no_roles_available__",
              },
              "options": [
                {
                  "description": {
                    "text": "Slack has no role picker; this bridge uses role IDs when available.",
                    "type": "plain_text",
                  },
                  "text": {
                    "emoji": true,
                    "text": "No roles available",
                    "type": "plain_text",
                  },
                  "value": "__no_roles_available__",
                },
              ],
              "type": "static_select",
            },
          ],
          "type": "actions",
        },
      ]
    `)
  })

  test('converts TextDisplay (Components V2)', () => {
    const components = [
      {
        type: ComponentType.TextDisplay,
        content: 'Hello **world**',
      },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "text": "Hello *world*",
            "type": "mrkdwn",
          },
          "type": "section",
        },
      ]
    `)
  })

  test('converts Separator to divider', () => {
    const components = [
      { type: ComponentType.Separator },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "type": "divider",
        },
      ]
    `)
  })

  test('converts Container by flattening children', () => {
    const components = [
      {
        type: ComponentType.Container,
        components: [
          { type: ComponentType.TextDisplay, content: 'Line 1' },
          { type: ComponentType.Separator },
          { type: ComponentType.TextDisplay, content: 'Line 2' },
        ],
      },
    ]

    expect(componentsToBlocks(components)).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "text": "Line 1",
            "type": "mrkdwn",
          },
          "type": "section",
        },
        {
          "type": "divider",
        },
        {
          "text": {
            "text": "Line 2",
            "type": "mrkdwn",
          },
          "type": "section",
        },
      ]
    `)
  })
})
