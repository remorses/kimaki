// Dynamic slash command names: Discord allows lowercase [a-z0-9-] names of
// at most 32 chars and 100 commands per guild.

import { expect, test } from 'vitest'

import { buildCommands, createInteractionRegistry } from './slash-commands.ts'

test('catalog names are sanitized, keep their suffix, skip collisions and MCP prompts, and stop at 100 commands', () => {
  const { commands, dynamic } = buildCommands({ fixed: createInteractionRegistry().definitions, catalog: {
    agents: [
      { id: 'gpt5.4', name: 'GPT 5.4', mode: 'primary', hidden: false },
      { id: 'explore', name: 'Explore', mode: 'subagent', hidden: false },
      { id: 'secret', name: 'Secret', mode: 'primary', hidden: true },
    ],
    commands: [
      { name: 'init' },
      // MCP prompt: no slash command.
      { name: 'github:create-pull-request' },
      { name: 'a-very-long-command-name-that-goes-on-and-on' },
      // Sanitizes to the same Discord name as the one before: first wins.
      { name: 'A_VERY_LONG_COMMAND_NAME_THAT_GOES_ON_AND_ON' },
      { name: 'queue' },
    ],
    skills: Array.from({ length: 90 }, (_, index) => ({ id: `skill-${index}` })),
  } })
  const names = commands.map((command) => command.name)
  expect(names.length).toBe(100)
  expect(names.filter((name) => !name.startsWith('skill-'))).toMatchInlineSnapshot(`
    [
      "cwd",
      "new-worktree",
      "worktrees",
      "merge-worktree",
      "login",
      "transcription-key",
      "new-session",
      "resume",
      "fork",
      "fork-subagent",
      "btw",
      "abort",
      "queue",
      "clear-queue",
      "queue-command",
      "compact",
      "undo",
      "redo",
      "diff",
      "context-usage",
      "session-id",
      "agent",
      "model",
      "model-variant",
      "verbosity",
      "tasks",
      "command",
      "skill",
      "gpt5-4-agent",
      "a-very-long-command-name-tha-cmd",
      "queue-cmd",
    ]
  `)
  expect(names.every((name) => /^[a-z0-9-]{1,32}$/.test(name))).toBe(true)
  expect(Object.fromEntries([...dynamic].filter(([name]) => !name.startsWith('skill-')))).toMatchInlineSnapshot(`
    {
      "a-very-long-command-name-tha-cmd": {
        "kind": "command",
        "name": "a-very-long-command-name-that-goes-on-and-on",
      },
      "gpt5-4-agent": {
        "kind": "agent",
        "name": "gpt5.4",
      },
      "queue-cmd": {
        "kind": "command",
        "name": "queue",
      },
    }
  `)
  expect(dynamic.has(names[names.length - 1]!)).toBe(true)
})
