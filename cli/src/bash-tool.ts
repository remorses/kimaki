// Bash tool for the GenAI worker.
// Executes shell commands in the project directory and can preload remote
// SKILL.md files into a local cache so their metadata can be exposed to the model.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { tool } from './ai-tool.js'
import { getDataDir } from './config.js'
import { execAsync } from './exec-async.js'
import { parseFrontmatter } from './forum-sync/markdown.js'
import { createLogger, LogPrefix } from './logger.js'

const bashToolLogger = createLogger(LogPrefix.TOOLS)
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_SHELL = process.env['SHELL'] || '/bin/zsh'

type CachedSkill = {
  content: string
  description: string
  location: string
  name: string
}

type BashToolGlobalState = {
  skills: Map<string, Promise<CachedSkill>>
}

const bashToolGlobalState = (() => {
  const key = '__kimakiBashToolState'
  const state = globalThis as typeof globalThis & {
    [key]?: BashToolGlobalState
  }
  if (!state[key]) {
    state[key] = {
      skills: new Map<string, Promise<CachedSkill>>(),
    }
  }
  return state[key]
})()

type ExecError = Error & {
  code?: number | string | null
  stderr?: string
  stdout?: string
}

function getExecErrorFields({
  error,
}: {
  error: unknown
}): {
  exitCode: number
  stderr: string
  stdout: string
} {
  if (!(error instanceof Error)) {
    return {
      exitCode: 1,
      stderr: String(error),
      stdout: '',
    }
  }

  const execError = error as ExecError
  return {
    exitCode: typeof execError.code === 'number' ? execError.code : 1,
    stderr: typeof execError.stderr === 'string' ? execError.stderr : error.message,
    stdout: typeof execError.stdout === 'string' ? execError.stdout : '',
  }
}

function sanitizeSkillName({ name }: { name: string }): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  )
}

export function normalizeSkillMarkdownUrl({ url }: { url: string }): string {
  const parsed = new URL(url)
  if (parsed.hostname !== 'github.com') {
    return parsed.toString()
  }

  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length < 5) {
    return parsed.toString()
  }

  const [owner, repo, kind, ref, ...rest] = parts
  if (kind !== 'blob' || rest.length === 0) {
    return parsed.toString()
  }

  return new URL(
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rest.join('/')}`,
  ).toString()
}

async function fetchSkillMarkdown({ url }: { url: string }): Promise<string> {
  const normalizedUrl = normalizeSkillMarkdownUrl({ url })
  const candidates =
    normalizedUrl === url ? [url] : [normalizedUrl, url]

  let lastStatus: number | null = null
  for (const candidate of candidates) {
    const response = await fetch(candidate)
    if (!response.ok) {
      lastStatus = response.status
      continue
    }
    return response.text()
  }

  throw new Error(
    `Failed to fetch skill markdown from ${url}${lastStatus ? ` (last status ${lastStatus})` : ''}`,
  )
}

async function cacheSkillMarkdown({
  url,
}: {
  url: string
}): Promise<CachedSkill> {
  const markdown = await fetchSkillMarkdown({ url })
  const parsed = parseFrontmatter({ markdown })
  const name = parsed.frontmatter['name']
  const description = parsed.frontmatter['description']

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`Skill at ${url} is missing a valid frontmatter name`)
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(`Skill at ${url} is missing a valid frontmatter description`)
  }

  const root = path.join(getDataDir(), 'remote-skills', sanitizeSkillName({ name }))
  await fs.promises.mkdir(root, { recursive: true })
  const location = path.join(root, 'SKILL.md')
  await fs.promises.writeFile(location, markdown, 'utf-8')

  return {
    content: parsed.body,
    description,
    location,
    name,
  }
}

export async function loadRemoteSkills({
  skillUrls,
}: {
  skillUrls: string[]
}): Promise<CachedSkill[]> {
  const uniqueUrls = Array.from(new Set(skillUrls))
  const loaded = await Promise.all(
    uniqueUrls.map(async (url) => {
      const cached = bashToolGlobalState.skills.get(url)
      if (cached) {
        return cached
      }

      const promise = cacheSkillMarkdown({ url }).catch((error) => {
        bashToolGlobalState.skills.delete(url)
        throw error
      })
      bashToolGlobalState.skills.set(url, promise)
      return promise
    }),
  )

  return loaded.sort((a, b) => a.name.localeCompare(b.name))
}

export function formatAvailableSkillsXml({
  skills,
}: {
  skills: CachedSkill[]
}): string {
  if (skills.length === 0) {
    return 'No skills are currently available.'
  }

  return [
    '<available_skills>',
    ...skills.flatMap((skill) => {
      return [
        '  <skill>',
        `    <name>${skill.name}</name>`,
        `    <description>${skill.description}</description>`,
        `    <location>${pathToFileURL(skill.location).href}</location>`,
        '  </skill>',
      ]
    }),
    '</available_skills>',
  ].join('\n')
}

function buildDescription({
  directory,
  skills,
}: {
  directory: string
  skills: CachedSkill[]
}): string {
  const lines = [
    `Execute a shell command in ${directory}.`,
    'Use `workdir` instead of `cd` commands when you need a different directory.',
    'Return fields include `stdout`, `stderr`, and `exitCode`.',
  ]

  if (skills.length === 0) {
    return lines.join('\n')
  }

  return [
    ...lines,
    '',
    'Skills provide specialized instructions and workflows for specific tasks.',
    'If a task matches a skill, read that SKILL.md file with bash before continuing.',
    formatAvailableSkillsXml({ skills }),
  ].join('\n')
}

export async function createBashTool({
  directory,
  skillUrls = [],
}: {
  directory: string
  skillUrls?: string[]
}) {
  const skills = await loadRemoteSkills({ skillUrls })
  const description = buildDescription({ directory, skills })

  if (skills.length > 0) {
    bashToolLogger.info(
      'Loaded cached remote skills for bash tool',
      skills.map((skill) => {
        return skill.name
      }),
    )
  }

  return tool({
    description,
    inputSchema: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout: z.number().optional().describe('Optional timeout in milliseconds'),
      workdir: z
        .string()
        .optional()
        .describe('Optional working directory. Use this instead of cd commands.'),
      description: z.string().describe('Short explanation of what the command does'),
      hasSideEffect: z
        .boolean()
        .optional()
        .describe('Whether this command writes files or changes external state'),
    }),
    execute: async ({ command, timeout, workdir }) => {
      const cwd = workdir || directory
      const result = await execAsync(command, {
        cwd,
        shell: DEFAULT_SHELL,
        timeout: timeout ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 10,
      })
        .then(({ stdout, stderr }) => {
          return {
            exitCode: 0,
            stderr,
            stdout,
          }
        })
        .catch((error) => {
          return getExecErrorFields({ error })
        })

      return result
    },
  })
}
