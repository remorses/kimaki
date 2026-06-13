// Computes opencode permission.skill rules from kimaki's --enable-skill /
// --disable-skill CLI flags.
//
// OpenCode filters skills available to the model via
// Permission.evaluate("skill", skill.name, agent.permission). We inject a
// top-level permission.skill ruleset into the generated opencode-config.json
// so every agent inherits the same whitelist/blacklist via Permission.merge.
//
// Whitelist mode: { '*': 'deny', 'name': 'allow', ... }
// Blacklist mode: { 'name': 'deny', ... }
// Neither set:    undefined (skills are unfiltered)
//
// cli.ts validates mutual exclusion of the two flags at startup, so this
// helper assumes at most one of the two arrays is non-empty.

type PermissionAction = 'ask' | 'allow' | 'deny'

export type SkillPermissionRule = Record<string, PermissionAction>

export function computeSkillPermission({
  enabledSkills,
  disabledSkills,
}: {
  enabledSkills: string[]
  disabledSkills: string[]
}): SkillPermissionRule | undefined {
  if (enabledSkills.length > 0) {
    const rules: SkillPermissionRule = { '*': 'deny' }
    for (const name of enabledSkills) {
      rules[name] = 'allow'
    }
    return rules
  }
  if (disabledSkills.length > 0) {
    const rules: SkillPermissionRule = {}
    for (const name of disabledSkills) {
      rules[name] = 'deny'
    }
    return rules
  }
  return undefined
}

// Checks whether a skill name is allowed by the current whitelist/blacklist.
// Used by registerCommands() to filter skill-sourced slash commands so they
// don't count toward Discord's 100-command limit when disabled.
export function isSkillAllowed({
  name,
  enabledSkills,
  disabledSkills,
}: {
  name: string
  enabledSkills: string[]
  disabledSkills: string[]
}): boolean {
  if (enabledSkills.length > 0) {
    return enabledSkills.includes(name)
  }
  if (disabledSkills.length > 0) {
    return !disabledSkills.includes(name)
  }
  return true
}
