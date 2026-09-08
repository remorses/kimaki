// Isolated opencode2 serve. Copy of packages/core/script/test.ts env plus plugin dirs.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildDeterministicOpencodeConfig } from 'opencode-deterministic-provider'

const require = createRequire(import.meta.url)

export function resolveOpencode2Binary() {
  const packageJsonPath = require.resolve('@opencode-ai/cli/package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const binPath =
    typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.opencode2
  if (!binPath) {
    throw new Error('@opencode-ai/cli is missing package.json bin.opencode2')
  }
  const binary = path.resolve(path.dirname(packageJsonPath), binPath)
  if (!fs.existsSync(binary)) {
    throw new Error(`@opencode-ai/cli binary not found at ${binary}`)
  }
  try {
    fs.accessSync(binary, fs.constants.X_OK)
  } catch {
    fs.chmodSync(binary, 0o755)
  }
  return binary
}

export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

export function isolatedEnv({
  home,
  extra,
}: {
  home: string
  extra?: Record<string, string>
}) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (
      /^(?:AWS|AZURE|GOOGLE|GCP|GCLOUD|VERTEX|OPENAI|ANTHROPIC|GEMINI|XAI|CLOUDFLARE|CF_AIG|SNOWFLAKE|AICORE|GITLAB|NPM_CONFIG)_/i.test(
        name,
      )
    ) {
      delete env[name]
      continue
    }
    if (/(?:^|_)(?:API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name)) {
      delete env[name]
    }
  }
  delete env['OPENCODE_CONFIG_CONTENT']
  env['HOME'] = home
  env['XDG_CONFIG_HOME'] = path.join(home, '.config')
  env['XDG_DATA_HOME'] = path.join(home, '.local', 'share')
  env['XDG_CACHE_HOME'] = path.join(home, '.cache')
  env['XDG_STATE_HOME'] = path.join(home, '.local', 'state')
  env['OPENCODE_CONFIG_DIR'] = path.join(home, '.config', 'opencode')
  env['OPENCODE_CONFIG'] = path.join(home, '.config', 'opencode', 'opencode.json')
  env['OPENCODE_LOG_LEVEL'] = 'INFO'
  if (extra) Object.assign(env, extra)
  return env
}

export async function waitForServe(child: ChildProcess) {
  let output = ''
  return await new Promise<{ url: string; password: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`opencode2 serve timeout\n${output}`))
    }, 20_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const url = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      const password = output.match(/server password (\S+)/)?.[1]
      if (url && password) {
        clearTimeout(timer)
        resolve({ url, password })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer)
        reject(new Error(`opencode2 exited ${code}\n${output}`))
      }
    })
  })
}

export async function opencodeApi({
  url,
  password,
  method,
  path: pathname,
  directory,
  body,
}: {
  url: string
  password: string
  method: string
  path: string
  directory: string
  body?: unknown
}) {
  const query = new URLSearchParams({ 'location[directory]': directory })
  const response = await fetch(`${url}${pathname}?${query}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

export function pluginDirs() {
  const root = path.resolve(process.cwd(), 'opencode-plugins')
  return {
    probe: path.join(root, 'probe'),
    queue: path.join(root, 'queue'),
    threads: path.join(root, 'threads'),
    discord: path.join(root, 'discord'),
    render: path.join(root, 'render'),
    btw: path.join(root, 'btw'),
    permissions: path.join(root, 'permissions'),
    commands: path.join(root, 'commands'),
  }
}

export function deterministicConfig({
  plugins,
}: {
  plugins: Array<string | { package: string; options?: Record<string, unknown> }>
}) {
  const providerNpm = pathToFileURL(
    path.resolve(process.cwd(), '..', 'opencode-deterministic-provider', 'src', 'index.ts'),
  ).toString()
  return {
    ...buildDeterministicOpencodeConfig({
      providerName: 'deterministic-provider',
      providerNpm,
      model: 'deterministic-v2',
      smallModel: 'deterministic-v2',
      settings: {
        strict: false,
        matchers: [
          {
            id: 'reply-exactly',
            when: { latestUserTextIncludes: 'Reply with exactly:' },
            then: {
              parts: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'ok' },
                { type: 'text-end', id: 't' },
                {
                  type: 'finish',
                  finishReason: 'stop',
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                },
              ],
            },
          },
        ],
      },
    }),
    plugins,
  }
}

export async function spawnOpencode2({
  cwd,
  home,
  extraEnv,
}: {
  cwd: string
  home: string
  extraEnv?: Record<string, string>
}) {
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugins: [] }),
  )
  const port = await freePort()
  const child = spawn(
    resolveOpencode2Binary(),
    ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'],
    {
      cwd,
      env: isolatedEnv({ home, extra: extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const serve = await waitForServe(child)
  return {
    child,
    serve,
    async stop() {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}
