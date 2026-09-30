#!/usr/bin/env node
// kimaki2 entrypoint. Starts the bot with saved credentials. The onboarding
// wizard, gateway mode and subcommands arrive in later phases (spec section 30).

import os from 'node:os'
import path from 'node:path'
import { goke } from 'goke'

import { openDb } from './db.ts'
import { DEFAULT_LOCK_PORT } from './lock-server.ts'
import { createLogger } from './logger.ts'
import { startBot } from './main.ts'

const logger = createLogger('CLI')

const cli = goke('kimaki2')

cli
  .command('', 'Start the bot with the credentials saved by kimaki onboarding')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .action(async (options) => {
    const dataDir = options.dataDir ?? path.join(os.homedir(), '.kimaki')
    const token = await (async () => {
      if (process.env['KIMAKI_BOT_TOKEN']) return process.env['KIMAKI_BOT_TOKEN']
      const opened = await openDb({ dataDir, migrate: true })
      if (opened instanceof Error) return opened
      const row = await opened.db.query.bot_tokens.findFirst({ where: { bot_mode: 'self_hosted' } })
      opened.close()
      return row?.token ?? null
    })()
    if (token instanceof Error) {
      logger.error(token.message)
      process.exit(1)
    }
    if (!token) {
      logger.error('No self-hosted bot token found. Run kimaki once to onboard, or set KIMAKI_BOT_TOKEN.')
      process.exit(1)
    }
    const bot = await startBot({
      dataDir,
      token,
      lockPort: Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT),
      ensureOpencode: true,
    })
    if (bot instanceof Error) {
      logger.error(bot.message)
      process.exit(1)
    }
    const shutdown = () => {
      void bot.stop().then(() => process.exit(0))
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
  })

cli.help()
void cli.parse()
