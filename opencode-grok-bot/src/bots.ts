// Readable model IDs for bots: `grok-bot/<slug>` instead of `grok-bot/<uuid>`.
//
//   "ghosthand x marketing"            ──▶ ghosthand-x-marketing
//   two bots named "backlinks"         ──▶ backlinks (the older one), backlinks-5ad0 (first 4 ID chars)
//   bot renamed "price checks" ▶ "prices" ──▶ prices; price-checks stays an alias in plugin storage
//   unknown slug (config-only model)   ──▶ created as a new bot
//
// Everything here is pure; index.ts loads and saves the aliases.

export type Bot = { id: string; name: string; isGroup?: boolean; createdAt?: number }
// Every slug a bot ever had, so renames keep old model IDs working.
export type Aliases = Record<string, string>

const SUFFIX_CHARS = 4
export function slugify(name: string) {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'bot'
}

// Current slug of every bot. Same-name bots: the oldest keeps the plain slug, so adding a
// duplicate never changes the model ID of a bot that already had one.
export function assignSlugs(bots: readonly Bot[]) {
  const groups = new Map<string, Bot[]>()
  for (const bot of bots) {
    const base = slugify(bot.name)
    groups.set(base, [...(groups.get(base) ?? []), bot])
  }
  const slugs = new Map<string, Bot>()
  for (const [base, group] of groups) {
    const ordered = [...group].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
    ordered.forEach((bot, index) => {
      slugs.set(index === 0 ? base : `${base}-${bot.id.replace(/-/g, '').slice(0, SUFFIX_CHARS)}`, bot)
    })
  }
  return slugs
}

// Aliases plus the current slugs; an alias of a deleted bot is dropped.
export function updateAliases({ aliases, slugs }: { aliases: Aliases; slugs: ReadonlyMap<string, Bot> }): Aliases {
  const alive = new Set([...slugs.values()].map((bot) => bot.id))
  const next: Aliases = {}
  for (const [slug, id] of Object.entries(aliases)) if (alive.has(id)) next[slug] = id
  for (const [slug, bot] of slugs) next[slug] = bot.id
  return next
}

export type Resolution = { type: 'bot'; bot: Bot } | { type: 'create'; name: string }

// What a model ID means right now. Current slugs win over aliases, so a new bot can take a
// slug only after no living bot holds it as an alias.
export function resolveSlug({ slug, bots, aliases, name }: { slug: string; bots: readonly Bot[]; aliases: Aliases; name?: string }): Resolution {
  const slugs = assignSlugs(bots)
  const current = slugs.get(slug)
  if (current) return { type: 'bot', bot: current }
  const aliased = aliases[slug] ? bots.find((bot) => bot.id === aliases[slug]) : undefined
  if (aliased) return { type: 'bot', bot: aliased }
  // Model IDs that still carry a raw bot ID keep working.
  const byID = bots.find((bot) => bot.id === slug)
  if (byID) return { type: 'bot', bot: byID }
  // A configured model name wins; otherwise the slug becomes a readable name.
  const configured = name && name !== slug ? name : slug.replace(/-/g, ' ')
  return { type: 'create', name: configured }
}
