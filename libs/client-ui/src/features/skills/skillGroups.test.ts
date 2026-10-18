import { describe, expect, it } from 'vitest'
import type { ResolvedSkill } from '@shared/skills'
import { groupSkills, packageName } from './skillGroups'

function skill(name: string, patch: Partial<ResolvedSkill> = {}): ResolvedSkill {
  return {
    name,
    description: '',
    dir: `/skills/${name}`,
    scope: 'user',
    source: 'auto',
    origin: 'top-level',
    writable: true,
    borrowed: false,
    draft: false,
    files: [],
    totalSize: 0,
    warnings: [],
    ...patch,
  }
}

describe('packageName', () => {
  it('drops the npm prefix and a pinned version, keeping scopes', () => {
    expect(packageName('npm:pi-subagents')).toBe('pi-subagents')
    expect(packageName('npm:pi-subagents@0.74.0')).toBe('pi-subagents')
    expect(packageName('npm:@saccolabs/pi-claude-cli')).toBe('@saccolabs/pi-claude-cli')
    expect(packageName('npm:@saccolabs/pi-claude-cli@1.0.0')).toBe('@saccolabs/pi-claude-cli')
    expect(packageName('git:github.com/u/repo@v1')).toBe('github.com/u/repo@v1')
  })
})

describe('groupSkills', () => {
  it('gives each package its own group, after your own roots', () => {
    const pkg = (name: string, source: string): ResolvedSkill =>
      skill(name, { origin: 'package', source, writable: false })
    const groups = groupSkills([
      pkg('council-mode', 'npm:pi-subagents'),
      skill('game-builder'),
      pkg('mcp-scripting', 'npm:pi-mcp-adapter'),
      pkg('pi-subagents', 'npm:pi-subagents'),
    ])
    expect(groups.map(([label, group]) => [label, group.map((s) => s.name)])).toEqual([
      ['Global · ~/.pi/agent/skills', ['game-builder']],
      ['Package · pi-mcp-adapter (read-only)', ['mcp-scripting']],
      ['Package · pi-subagents (read-only)', ['council-mode', 'pi-subagents']],
    ])
  })
})
