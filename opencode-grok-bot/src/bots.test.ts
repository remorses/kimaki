import { expect, test } from 'vitest'
import { assignSlugs, resolveSlug, updateAliases, type Bot } from './bots.ts'

const bots: Bot[] = [
  { id: '52c583f1-0ee8-426a-9fdf-b712919f9e8b', name: 'ghosthand x marketing', createdAt: 1 },
  { id: '9f1e77aa-0000-4000-8000-000000000001', name: 'backlinks', createdAt: 5 },
  { id: '5ad0c1b2-0000-4000-8000-000000000002', name: 'Backlinks!', createdAt: 9 },
  { id: '29dbebc8-0cf0-4a0e-b0ec-dc885ece579a', name: 'Café Ops', createdAt: 3, isGroup: true },
]

test('slugs are kebab-case names; same-name bots get the first 4 ID chars, the oldest keeps the plain slug', () => {
  expect(Object.fromEntries([...assignSlugs(bots)].map(([slug, bot]) => [slug, bot.id.slice(0, 8)]))).toMatchInlineSnapshot(`
    {
      "backlinks": "9f1e77aa",
      "backlinks-5ad0": "5ad0c1b2",
      "cafe-ops": "29dbebc8",
      "ghosthand-x-marketing": "52c583f1",
    }
  `)
})

test('renames keep old slugs as aliases, unknown slugs create bots', () => {
  const before = updateAliases({ aliases: {}, slugs: assignSlugs(bots) })
  const renamed = bots.map((bot) => (bot.name === 'ghosthand x marketing' ? { ...bot, name: 'ghosthand growth' } : bot))
  const aliases = updateAliases({ aliases: before, slugs: assignSlugs(renamed) })
  const resolve = (slug: string, name?: string) => {
    const result = resolveSlug({ slug, bots: renamed, aliases, name })
    return result.type === 'bot' ? `bot ${result.bot.id.slice(0, 8)}` : `create "${result.name}"`
  }
  expect({
    renamedNew: resolve('ghosthand-growth'),
    renamedOld: resolve('ghosthand-x-marketing'),
    duplicate: resolve('backlinks-5ad0'),
    rawID: resolve('29dbebc8-0cf0-4a0e-b0ec-dc885ece579a'),
    numbered: resolve('backlinks-2'),
    unknown: resolve('my-new-bot'),
    configuredName: resolve('researcher', 'Market Researcher'),
  }).toMatchInlineSnapshot(`
    {
      "configuredName": "create "Market Researcher"",
      "duplicate": "bot 5ad0c1b2",
      "numbered": "create "backlinks 2"",
      "rawID": "bot 29dbebc8",
      "renamedNew": "bot 52c583f1",
      "renamedOld": "bot 52c583f1",
      "unknown": "create "my new bot"",
    }
  `)
  // A deleted bot's aliases go away, so its slug can name a new bot later.
  expect(updateAliases({ aliases, slugs: assignSlugs(renamed.filter((bot) => !bot.name.startsWith('ghosthand'))) })).not.toHaveProperty('ghosthand-x-marketing')
})
