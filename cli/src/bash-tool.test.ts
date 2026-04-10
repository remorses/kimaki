// Tests for the GenAI bash tool helper and remote skill loading cache.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { setDataDir } from './config.js'
import {
  formatAvailableSkillsXml,
  loadRemoteSkills,
  normalizeSkillMarkdownUrl,
} from './bash-tool.js'

const tempRoot = path.join(process.cwd(), 'tmp', 'bash-tool-tests')
let server: http.Server | undefined
let serverUrl = ''
let requestCount = 0

beforeAll(async () => {
  await fs.promises.mkdir(tempRoot, { recursive: true })
  setDataDir(tempRoot)

  server = http.createServer((request, response) => {
    if (request.url !== '/skill.md') {
      response.statusCode = 404
      response.end('missing')
      return
    }

    requestCount += 1
    response.setHeader('content-type', 'text/markdown; charset=utf-8')
    response.end(`---
name: remote-skill
description: Remote cached skill for bash tool tests
---

# Remote skill

Use this skill in tests.
`)
  })

  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (typeof address === 'object' && address) {
        serverUrl = `http://127.0.0.1:${address.port}/skill.md`
      }
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve()
      return
    }

    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
})

describe('normalizeSkillMarkdownUrl', () => {
  test('converts GitHub blob URLs to raw content URLs', () => {
    expect(
      normalizeSkillMarkdownUrl({
        url: 'https://github.com/remorses/kimaki/blob/main/cli/skills/errore/SKILL.md',
      }),
    ).toBe(
      'https://raw.githubusercontent.com/remorses/kimaki/main/cli/skills/errore/SKILL.md',
    )
  })
})

describe('loadRemoteSkills', () => {
  test('fetches once, caches, writes SKILL.md, and formats skill XML', async () => {
    const first = await loadRemoteSkills({ skillUrls: [serverUrl] })
    const second = await loadRemoteSkills({ skillUrls: [serverUrl] })

    expect(requestCount).toBe(1)
    expect(second[0]?.location).toBe(first[0]?.location)
    expect(await fs.promises.readFile(first[0]!.location, 'utf-8')).toContain(
      'name: remote-skill',
    )
    expect(formatAvailableSkillsXml({ skills: first })).toMatchInlineSnapshot(`
      "<available_skills>
        <skill>
          <name>remote-skill</name>
          <description>Remote cached skill for bash tool tests</description>
          <location>file:///Users/morse/Documents/GitHub/kimakivoice/cli/tmp/bash-tool-tests/remote-skills/remote-skill/SKILL.md</location>
        </skill>
      </available_skills>"
    `)
  })
})
