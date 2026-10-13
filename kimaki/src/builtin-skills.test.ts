import { expect, test } from 'vitest'

import { BUILTIN_SKILL_IDS, disabledSkillRules, parseDisabledSkills, readBuiltinSkills } from './builtin-skills.ts'

test('every built-in skill file parses', async () => {
  const skills = await readBuiltinSkills()
  if (skills instanceof Error) throw skills
  expect(skills.map((skill) => skill.id)).toEqual([...BUILTIN_SKILL_IDS])
  for (const skill of skills) {
    expect(skill.description, skill.id).toContain('Only for Kimaki Discord sessions')
    expect(skill.content.startsWith('# '), skill.id).toBe(true)
  }
})

test('--disable-skills accepts all, a list, and rejects unknown ids', () => {
  expect(parseDisabledSkills(undefined)).toEqual([])
  expect(parseDisabledSkills('kimaki-tunnel, kimaki-debug')).toEqual(['kimaki-tunnel', 'kimaki-debug'])
  expect(parseDisabledSkills('all')).toEqual([...BUILTIN_SKILL_IDS])
  expect(parseDisabledSkills('tunnel')).toBeInstanceOf(Error)
  expect(disabledSkillRules(['kimaki-tunnel'])).toMatchInlineSnapshot(`
    [
      {
        "action": "skill",
        "effect": "deny",
        "resource": "kimaki-tunnel",
      },
    ]
  `)
})
