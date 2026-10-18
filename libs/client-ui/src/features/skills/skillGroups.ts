import type { ResolvedSkill } from '@shared/skills'

/** `npm:pi-subagents@1.2.0` → `pi-subagents`; git and path specs lose only the prefix. */
export function packageName(source: string): string {
  const spec = source.replace(/^(npm|git):/, '')
  if (!source.startsWith('npm:')) return spec
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * A human root label per skill, derived from its directory. Grouping by root
 * (not just scope) is the honesty the page exists for: `~/.claude/skills` and
 * `~/.pi/agent/skills` are both "user" to pi, and telling them apart is how
 * the user knows what a borrowed skill is. Package skills group per package,
 * so what each installed extension brought with it is visible at a glance.
 */
export function rootLabel(skill: ResolvedSkill): string {
  if (skill.origin === 'package') return `Package · ${packageName(skill.source)} (read-only)`
  const scope = skill.scope === 'project' ? 'Project' : 'Global'
  if (skill.borrowed) return `${scope} · .claude/skills (borrowed)`
  if (!skill.writable && skill.scope === 'user') return `Global · other`
  return skill.scope === 'project' ? 'Project · .pi/skills' : 'Global · ~/.pi/agent/skills'
}

/**
 * Skills grouped by `rootLabel`: your own roots first, in the order their
 * first skill appears, then one group per package, alphabetically.
 */
export function groupSkills(skills: ResolvedSkill[]): Array<[string, ResolvedSkill[]]> {
  const groups = new Map<string, ResolvedSkill[]>()
  for (const skill of skills) {
    const label = rootLabel(skill)
    groups.set(label, [...(groups.get(label) ?? []), skill])
  }
  const own = [...groups.entries()].filter(([, group]) => group[0]!.origin !== 'package')
  const packages = [...groups.entries()]
    .filter(([, group]) => group[0]!.origin === 'package')
    .sort(([a], [b]) => a.localeCompare(b))
  return [...own, ...packages]
}
