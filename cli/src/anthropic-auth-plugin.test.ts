// Tests Anthropic system prompt rewriting so project instructions survive OpenCode prompt layout changes.

import { describe, expect, test } from 'vitest'
import { replacer } from './anthropic-auth-plugin.js'

async function transformSystem(systemText: string) {
  const plugin = await replacer({} as never)
  const transform = plugin['experimental.chat.system.transform']
  if (!transform) throw new Error('missing system transform hook')

  const output = { system: [systemText] }
  await transform(
    {
      model: { providerID: 'anthropic' },
    } as never,
    output,
  )
  return output.system.join('\n')
}

describe('Anthropic system prompt rewriting', () => {
  test('preserves instructions when OpenCode places them before skills', async () => {
    const transformed = await transformSystem(`You are OpenCode, the best coding agent on the planet.
<env>
  Working directory: /repo/site
  Platform: darwin
</env>
Instructions from: /repo/site/SOUL.md
I am Extra Chill Bot.
Skills provide specialized instructions and workflows.
Use skills wisely.`)

    expect(transformed).toMatchInlineSnapshot(`
      "
      <environment>
      <cwd>/repo/site</cwd>
      </environment>
      Read, write, and edit files under /repo/site.

      Instructions from: /repo/site/SOUL.md
      I am Extra Chill Bot.
      Skills provide specialized instructions and workflows.
      Use skills wisely."
    `)
  })

  test('preserves instructions when OpenCode places skills before them', async () => {
    const transformed = await transformSystem(`You are OpenCode, the best coding agent on the planet.
<env>
  Working directory: /repo/site
  Platform: darwin
</env>
Skills provide specialized instructions and workflows.
Use skills wisely.
Instructions from: /repo/site/SOUL.md
I am Extra Chill Bot.`)

    expect(transformed).toMatchInlineSnapshot(`
      "
      <environment>
      <cwd>/repo/site</cwd>
      </environment>
      Read, write, and edit files under /repo/site.

      Skills provide specialized instructions and workflows.
      Use skills wisely.
      Instructions from: /repo/site/SOUL.md
      I am Extra Chill Bot."
    `)
  })

  test('leaves text unchanged when the OpenCode env block is incomplete', async () => {
    const prompt = `You are OpenCode, the best coding agent on the planet.
<env>
  Working directory: /repo/site
Instructions from: /repo/site/SOUL.md
I am Extra Chill Bot.`

    await expect(transformSystem(prompt)).resolves.toBe(prompt)
  })
})
