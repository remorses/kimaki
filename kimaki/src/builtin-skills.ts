// Opt-out skills Kimaki ships in skills/<id>/SKILL.md (debug, tunnel). They are
// not in the system prompt, which keeps the rest of the CLI reference.
//
//   plugin (OpenCode process) ──▶ readBuiltinSkills ──▶ ctx.skill.transform(add)
//   bot ──▶ --disable-skills ──▶ session permissions `skill:<id>` deny
//
// Plugin files must not pull in discord.js or SQLite: keep this module plain fs.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConfigError, FilesystemError } from './errors.ts'

export const BUILTIN_SKILL_IDS = ['kimaki-debug', 'kimaki-tunnel'] as const

export type BuiltinSkillId = (typeof BUILTIN_SKILL_IDS)[number]

export function isBuiltinSkill(id: string): boolean {
  return (BUILTIN_SKILL_IDS as readonly string[]).includes(id)
}

// src/ and dist/ both sit next to skills/.
const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills')

export type BuiltinSkill = { id: string; name: string; description: string; path: string; content: string }

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter)?.[1]?.trim()
}

export async function readBuiltinSkills(): Promise<FilesystemError | BuiltinSkill[]> {
  const skills: BuiltinSkill[] = []
  for (const id of BUILTIN_SKILL_IDS) {
    const file = path.join(SKILLS_DIR, id, 'SKILL.md')
    const text = await fs.promises.readFile(file, 'utf8').catch((cause) => new FilesystemError({ operation: `read ${file}`, cause }))
    if (text instanceof Error) return text
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
    const description = match?.[1] ? frontmatterValue(match[1], 'description') : undefined
    if (!match || !description) return new FilesystemError({ operation: `parse ${file}: missing frontmatter description` })
    // Virtual path: OpenCode has no file to scan for these (same as its /builtin skills).
    skills.push({ id, name: id, description, path: `/kimaki/${id}.md`, content: match[2]!.trim() })
  }
  return skills
}

// `all` or a comma separated list of built-in skill ids.
export function parseDisabledSkills(value: string | undefined): ConfigError | BuiltinSkillId[] {
  const items = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  if (items.includes('all')) return [...BUILTIN_SKILL_IDS]
  const unknown = items.filter((item) => !isBuiltinSkill(item))
  if (unknown.length > 0) return new ConfigError({ reason: `Unknown built-in skill ${unknown.join(', ')}. Choose from: all, ${BUILTIN_SKILL_IDS.join(', ')}` })
  return items as BuiltinSkillId[]
}

// OpenCode hides a skill from the model and the skill tool when its permission is denied.
export function disabledSkillRules(disabled: readonly string[]) {
  return disabled.map((id) => ({ action: 'skill', resource: id, effect: 'deny' }) as const)
}
