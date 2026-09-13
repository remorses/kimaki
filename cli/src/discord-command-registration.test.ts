// Tests Discord slash command payloads for quick agent commands.

import { describe, expect, test } from 'vitest'
import { buildQuickAgentSlashCommand } from './discord-command-registration.js'

describe('buildQuickAgentSlashCommand', () => {
  test('puts variant last after prompt', () => {
    const command = buildQuickAgentSlashCommand({
      commandName: 'plan-agent',
      description: 'Switch to plan agent',
    }).toJSON()

    expect(command.options?.map((option) => option.name)).toMatchInlineSnapshot(`
      [
        "prompt",
        "variant",
      ]
    `)
  })
})
