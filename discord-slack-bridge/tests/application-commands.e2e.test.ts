// E2E coverage for application command registration/listing parity routes.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('application command routes', () => {
  let ctx: E2EContext
  let applicationId: string

  beforeAll(async () => {
    ctx = await setupE2E()
    applicationId = ctx.client.user?.id ?? ''
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('global commands PUT + GET support bulk overwrite semantics', async () => {
    const putResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/commands`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { name: 'hello', description: 'Say hello' },
          { name: 'status', description: 'Show status' },
        ]),
      },
    )
    const putBody = (await putResponse.json()) as Array<{ name: string }>
    expect(putResponse.status).toBe(200)
    expect(putBody.map((entry) => entry.name).sort()).toEqual(['hello', 'status'])

    const overwriteResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/commands`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ name: 'hello', description: 'Say hello again' }]),
      },
    )
    expect(overwriteResponse.status).toBe(200)

    const listResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/commands`,
    )
    const listBody = (await listResponse.json()) as Array<{ name: string }>
    expect(listResponse.status).toBe(200)
    expect(listBody.map((entry) => entry.name)).toEqual(['hello'])
  })

  test('guild commands are isolated from global commands', async () => {
    const guildCommandsResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/guilds/${ctx.twin.workspaceId}/commands`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { name: 'guild-only', description: 'Guild command' },
          { name: 'queue', description: 'Queue command' },
        ]),
      },
    )
    const guildCommands =
      (await guildCommandsResponse.json()) as Array<{ id: string; name: string }>
    expect(guildCommandsResponse.status).toBe(200)
    expect(guildCommands.map((command) => command.name).sort()).toEqual([
      'guild-only',
      'queue',
    ])

    const listGuildResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/guilds/${ctx.twin.workspaceId}/commands`,
    )
    const listedGuildCommands =
      (await listGuildResponse.json()) as Array<{ id: string; name: string }>
    expect(listGuildResponse.status).toBe(200)
    expect(listedGuildCommands.map((command) => command.name).sort()).toEqual([
      'guild-only',
      'queue',
    ])

    const singleCommandResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/guilds/${ctx.twin.workspaceId}/commands/${guildCommands[0]?.id}`,
    )
    const singleCommand = (await singleCommandResponse.json()) as {
      id: string
      name: string
    }
    expect(singleCommandResponse.status).toBe(200)
    expect(singleCommand.id).toBe(guildCommands[0]?.id)

    const unknownCommandResponse = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/guilds/${ctx.twin.workspaceId}/commands/170000000000000001`,
    )
    const unknownCommandBody = await unknownCommandResponse.json()
    expect(unknownCommandResponse.status).toBe(404)
    expect(unknownCommandBody).toMatchObject({
      code: 10063,
      error: 'unknown_application_command',
      message: 'Unknown application command',
    })
  })

  test('guild command routes reject mismatched guild id', async () => {
    const response = await fetch(
      `${ctx.bridge.restUrl}/v10/applications/${applicationId}/guilds/T_WRONG_GUILD/commands`,
    )
    const body = await response.json()
    expect(response.status).toBe(404)
    expect(body).toMatchObject({
      code: 10004,
      error: 'unknown_guild',
      message: 'Unknown Guild: T_WRONG_GUILD',
    })
  })
})
