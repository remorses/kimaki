#!/usr/bin/env node
// kimaki entrypoint. `kimaki` starts the bot and onboards on first start;
// the subcommands live in src/cli/*.ts, one module per job.
// Startup must stay light: bot modules (main.ts, onboarding.ts, scheduler.ts)
// are imported lazily inside the commands that need them.

import { goke } from 'goke'

import { registerBotCommands, registerLoginCommands, registerStartCommand, registerToolCommands } from './cli/bot.ts'
import { registerAgentUiCommands, registerDiscordCommands } from './cli/discord.ts'
import { registerChannelPreferenceCommands, registerChannelWorktreeCommand, registerProjectCommands, registerWorktreeCommands } from './cli/project.ts'
import { registerScheduleCommands, registerSendCommand } from './cli/schedule.ts'
import { registerSessionActionCommands, registerSessionHistoryCommands, registerSessionQueryCommands } from './cli/session.ts'

const cli = goke('kimaki')

// Registration order is the --help order; goke groups consecutive commands under each section.
registerStartCommand(cli)

cli.section('Project')
registerProjectCommands(cli)

cli.section('Session')
registerSessionQueryCommands(cli)
registerChannelPreferenceCommands(cli)
registerSessionActionCommands(cli)
registerAgentUiCommands(cli)
registerLoginCommands(cli)
registerSendCommand(cli)
registerSessionHistoryCommands(cli)

cli.section('Channel')
registerChannelWorktreeCommand(cli)

cli.section('Worktree')
registerWorktreeCommands(cli)

cli.section('Schedule')
registerScheduleCommands(cli)

cli.section('Discord')
registerDiscordCommands(cli)

cli.section('Tools')
registerToolCommands(cli)

cli.section('Bot')
registerBotCommands(cli)

cli.help()
void cli.parse()
