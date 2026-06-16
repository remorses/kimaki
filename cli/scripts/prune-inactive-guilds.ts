// Prune inactive guilds from the shared gateway bot.
// Lists all guilds the bot is in, sorted by member count, and optionally
// leaves guilds that have no kimaki users (no gateway_clients row).
//
// Usage:
//   # Dry run — just list guilds and categorize them:
//   doppler run -p kimaki -c production -- tsx scripts/prune-inactive-guilds.ts
//
//   # Actually leave inactive guilds:
//   doppler run -p kimaki -c production -- tsx scripts/prune-inactive-guilds.ts --leave
//
//   # Keep specific guild IDs even if they have no gateway_clients row:
//   doppler run -p kimaki -c production -- tsx scripts/prune-inactive-guilds.ts --keep 123456,789012
//
// Env vars:
//   DISCORD_BOT_TOKEN — the real gateway bot token (not a clientId:secret credential)
//   DATABASE_URL      — Postgres connection string for gateway_clients table
//
// By default runs in dry-run mode. Pass --leave to actually leave inactive guilds.
//
// pg resolution: pg is installed in the db/ workspace package, not cli/.
// We use createRequire to resolve it from db/package.json so the script works
// regardless of which directory you run it from.

import { createRequire } from 'node:module'
import { REST, Routes } from 'discord.js'

// Resolve pg from the db/ workspace package where it is installed
const dbRequire = createRequire(
  new URL('../../db/package.json', import.meta.url),
)
const { Pool } = dbRequire('pg') as typeof import('pg')

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
if (!BOT_TOKEN) {
  console.error(
    'DISCORD_BOT_TOKEN env var is required (the real bot token, not a gateway credential)',
  )
  process.exit(1)
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error(
    'DATABASE_URL env var is required (Postgres connection string for gateway_clients table)',
  )
  process.exit(1)
}

const shouldLeave = process.argv.includes('--leave')
const keepIndex = process.argv.indexOf('--keep')
const keepGuildIds = new Set(
  keepIndex !== -1 && process.argv[keepIndex + 1]
    ? process.argv[keepIndex + 1]!.split(',').map((s) => s.trim())
    : [],
)

interface DiscordGuild {
  id: string
  name: string
  approximate_member_count?: number
  approximate_presence_count?: number
  owner: boolean
}

async function fetchActiveGuildIds(): Promise<Set<string>> {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    const result = await pool.query<{ guild_id: string }>(
      "SELECT DISTINCT guild_id FROM gateway_clients WHERE platform = 'discord'",
    )
    return new Set(result.rows.map((r) => r.guild_id))
  } finally {
    await pool.end()
  }
}

async function main() {
  const rest = new REST().setToken(BOT_TOKEN!)

  // 1. Fetch all guilds the bot is in (paginated, 200 per page)
  console.log('Fetching bot guilds...')
  let allGuilds: DiscordGuild[] = []
  let after: string | undefined
  while (true) {
    const params = new URLSearchParams({
      limit: '200',
      with_counts: 'true',
    })
    if (after) params.set('after', after)

    const batch = (await rest.get(Routes.userGuilds(), {
      query: params,
    })) as DiscordGuild[]

    allGuilds = allGuilds.concat(batch)
    console.log(`  fetched ${allGuilds.length} guilds so far...`)

    if (batch.length < 200) break
    after = batch[batch.length - 1]!.id
  }
  console.log(`Total guilds: ${allGuilds.length}`)

  // 2. Fetch active guild IDs from gateway_clients table
  console.log('Fetching active gateway_clients from Postgres...')
  const activeGuildIds = await fetchActiveGuildIds()
  console.log(`Active guilds (with gateway_clients): ${activeGuildIds.size}`)

  // 3. Categorize guilds
  const active: DiscordGuild[] = []
  const inactive: DiscordGuild[] = []

  for (const guild of allGuilds) {
    if (activeGuildIds.has(guild.id) || keepGuildIds.has(guild.id)) {
      active.push(guild)
    } else {
      inactive.push(guild)
    }
  }

  // Sort by member count ascending (smallest first = most likely dead)
  active.sort(
    (a, b) =>
      (a.approximate_member_count || 0) - (b.approximate_member_count || 0),
  )
  inactive.sort(
    (a, b) =>
      (a.approximate_member_count || 0) - (b.approximate_member_count || 0),
  )

  console.log('')
  console.log('=== ACTIVE GUILDS (have gateway_clients, will keep) ===')
  for (const g of active) {
    const kept = keepGuildIds.has(g.id) ? '  [--keep]' : ''
    console.log(
      `  ${g.id}  ${String(g.approximate_member_count ?? '?').padStart(6)} members  ${g.name}${kept}`,
    )
  }

  console.log('')
  console.log(
    '=== INACTIVE GUILDS (no gateway_clients, candidates for removal) ===',
  )
  for (const g of inactive) {
    console.log(
      `  ${g.id}  ${String(g.approximate_member_count ?? '?').padStart(6)} members  ${g.name}`,
    )
  }

  console.log('')
  console.log(
    `Summary: ${active.length} active, ${inactive.length} inactive, ${allGuilds.length} total`,
  )

  if (!shouldLeave) {
    console.log('')
    console.log('Dry run. Pass --leave to leave all inactive guilds.')
    return
  }

  // 4. Re-fetch active guild IDs to avoid leaving a guild that was just onboarded
  //    between the initial query and the leave loop.
  console.log('')
  console.log('Re-checking active guilds before leaving...')
  const latestActiveGuildIds = await fetchActiveGuildIds()
  const guildsToLeave = inactive.filter(
    (guild) =>
      !latestActiveGuildIds.has(guild.id) && !keepGuildIds.has(guild.id),
  )
  const skippedCount = inactive.length - guildsToLeave.length
  if (skippedCount > 0) {
    console.log(
      `  ${skippedCount} guild(s) became active since initial check, skipping them.`,
    )
  }

  // 5. Leave inactive guilds
  console.log(`Leaving ${guildsToLeave.length} inactive guilds...`)
  let left = 0
  let failed = 0
  for (const guild of guildsToLeave) {
    try {
      await rest.delete(Routes.userGuild(guild.id))
      left++
      console.log(
        `  [${left}/${guildsToLeave.length}] Left: ${guild.name} (${guild.id})`,
      )
    } catch (error) {
      failed++
      console.error(
        `  [FAIL] Could not leave ${guild.name} (${guild.id}): ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  console.log('')
  console.log(`Done. Left ${left} guilds, ${failed} failures.`)
  console.log(`Remaining guilds: ~${allGuilds.length - left}`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
