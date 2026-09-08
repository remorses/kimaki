// Digital Twin + real opencode2. Fake Discord only. Plugins run inside opencode2.

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { ChannelType } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  deterministicConfig,
  opencodeApi,
  pluginDirs,
  spawnOpencode2,
} from './opencode2-serve.ts'
import { resetKimakiRuntime } from './runtime.ts'

export const TEST_USER_ID = '200000000000000777'
export const TEXT_CHANNEL_ID = '200000000000000778'

function initTestGitRepo(directory: string) {
  if (fs.existsSync(path.join(directory, '.git'))) return
  execSync('git init -b main', { cwd: directory, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: directory, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: directory, stdio: 'pipe' })
  execSync('git commit --allow-empty -m "init"', { cwd: directory, stdio: 'pipe' })
}

export async function bootKimaki2E2e({
  dirName,
  turnDelayMs = 0,
}: {
  dirName: string
  turnDelayMs?: number
}) {
  resetKimakiRuntime()
  const root = path.resolve(process.cwd(), 'tmp', dirName)
  fs.mkdirSync(root, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const home = path.join(root, 'home')
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  initTestGitRepo(projectDirectory)

  const discord = new DigitalDiscord({
    guild: { name: 'Kimaki2 E2E Guild', ownerId: TEST_USER_ID },
    channels: [{ id: TEXT_CHANNEL_ID, name: 'project', type: ChannelType.GuildText }],
    users: [{ id: TEST_USER_ID, username: 'queue-tester' }],
    dbUrl: `file:${path.join(dataDir, 'digital-discord.db')}`,
  })
  await discord.start()

  const dirs = pluginDirs()
  const options = {
    token: discord.botToken,
    restApi: discord.restUrl,
    clientId: discord.botUserId,
    guildId: discord.guildId,
    channels: { [TEXT_CHANNEL_ID]: projectDirectory },
  }
  const config = deterministicConfig({
    plugins: [
      dirs.queue,
      { package: dirs.threads, options },
      { package: dirs.discord, options },
      dirs.render,
      dirs.btw,
      dirs.permissions,
      { package: dirs.commands, options },
      dirs.rpc,
    ],
  })
  if (turnDelayMs > 0) {
    const provider = config.provider?.['deterministic-provider']
    if (provider?.options) provider.options.defaultPartDelayMs = turnDelayMs
  }
  fs.writeFileSync(path.join(projectDirectory, 'opencode.json'), JSON.stringify(config, null, 2))

  const server = await spawnOpencode2({ cwd: root, home })
  const wait = await opencodeApi({
    url: server.serve.url,
    password: server.serve.password,
    method: 'POST',
    path: '/api/plugin/await-activation',
    directory: projectDirectory,
  })
  if (wait.status < 200 || wait.status >= 300) {
    await server.stop()
    await discord.stop()
    throw new Error(`await-activation ${wait.status}`)
  }

  return {
    discord,
    projectDirectory,
    server,
    async stop() {
      await server.stop()
      await discord.stop()
      resetKimakiRuntime()
    },
  }
}

export async function waitForThreadText({
  discord,
  threadId,
  includes,
}: {
  discord: DigitalDiscord
  threadId: string
  includes: string
}) {
  const start = Date.now()
  while (Date.now() - start < 15_000) {
    const timeline = await discord.thread(threadId).text()
    if (timeline.includes(includes)) return timeline
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return discord.thread(threadId).text()
}
