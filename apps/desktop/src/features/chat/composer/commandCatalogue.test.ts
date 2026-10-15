import { describe, expect, it } from 'vitest'
import type { RpcSlashCommand } from '@shared/rpc'
import {
  buildCommandEntries,
  dedupeAliases,
  entryTooltip,
  filterCommandEntries,
  originLabel,
  type CommandBadge,
} from './commandCatalogue'
import { REAL_PI_COMMANDS } from './__fixtures__/piCommands'

const NATIVE = [
  { name: 'compact', description: 'Compact conversation context now', run: () => {} },
  { name: 'export', description: 'Export this session as HTML', run: () => {} },
  { name: 'name', description: 'Rename this session', run: () => {} },
]

const byName = (names: readonly { name: string }[]): string[] => names.map((e) => e.name)

describe('originLabel', () => {
  const find = (name: string) => REAL_PI_COMMANDS.find((c) => c.name === name)!

  it('names the package for a package command', () => {
    expect(originLabel(find('websearch'))).toBe('pi-web-access')
    expect(originLabel(find('computer-use'))).toBe('@injaneity/pi-computer-use')
  })

  it("says built into pi for pi's built-in and inline extensions", () => {
    expect(originLabel(find('mcp'))).toBe('built into pi')
    expect(originLabel(find('llama'))).toBe('built into pi')
  })

  it('gives a local skill its scope and root', () => {
    expect(originLabel(find('skill:debug'))).toBe('project · .claude/skills')
    expect(originLabel(find('skill:test-augie-e2e-slack'))).toBe('user · .claude/skills')
    expect(originLabel(find('skill:game-builder'))).toBe('user · .pi/agent/skills')
  })

  it('names the package for a skill bundled in one', () => {
    expect(
      originLabel({
        name: 'skill:pi-subagents',
        source: 'skill',
        sourceInfo: {
          path: '/home/dev/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md',
          source: 'npm:pi-subagents',
          scope: 'user',
          origin: 'package',
        },
      }),
    ).toBe('pi-subagents')
  })

  it('falls back to scope alone for an unknown root, and to source with no info', () => {
    expect(
      originLabel({
        name: 'x',
        source: 'prompt',
        sourceInfo: {
          path: '/somewhere/x.md',
          source: 'local',
          scope: 'user',
          origin: 'top-level',
        },
      }),
    ).toBe('user')
    expect(originLabel({ name: 'x', source: 'prompt' })).toBe('prompt')
  })

  it('reads Windows paths too', () => {
    expect(
      originLabel({
        name: 'skill:x',
        source: 'skill',
        sourceInfo: {
          path: 'C:\\Users\\dev\\.pi\\agent\\skills\\x\\SKILL.md',
          source: 'auto',
          scope: 'user',
          origin: 'top-level',
        },
      }),
    ).toBe('user · .pi/agent/skills')
  })
})

describe('dedupeAliases', () => {
  it('folds two names from one file with one description into one row', () => {
    const rows = dedupeAliases([...REAL_PI_COMMANDS, ...ALIASED])
    expect(rows).toHaveLength(REAL_PI_COMMANDS.length + 1)
    const status = rows.find((r) => r.command.name === 'status')!
    expect(status.aliases).toEqual(['st'])
    expect(rows.some((r) => r.command.name === 'st')).toBe(false)
  })

  it('keeps the first registration as the row', () => {
    const rows = dedupeAliases([
      { name: 'b', description: 'same', source: 'extension', sourceInfo: info('/x.ts') },
      { name: 'a', description: 'same', source: 'extension', sourceInfo: info('/x.ts') },
    ])
    expect(byName(rows.map((r) => r.command))).toEqual(['b'])
    expect(rows[0]!.aliases).toEqual(['a'])
  })

  it('does not fold same-file commands whose descriptions differ', () => {
    const rows = dedupeAliases(REAL_PI_COMMANDS)
    expect(rows).toHaveLength(REAL_PI_COMMANDS.length)
    expect(rows.filter((r) => r.command.sourceInfo?.source === 'npm:pi-web-access')).toHaveLength(4)
  })

  it('never folds on a missing description or a missing path', () => {
    const rows = dedupeAliases([
      { name: 'a', source: 'extension', sourceInfo: info('/x.ts') },
      { name: 'b', source: 'extension', sourceInfo: info('/x.ts') },
      { name: 'c', description: 'same', source: 'extension' },
      { name: 'd', description: 'same', source: 'extension' },
    ])
    expect(byName(rows.map((r) => r.command))).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('buildCommandEntries', () => {
  it('puts native commands first, then every pi command once', () => {
    const entries = buildCommandEntries(REAL_PI_COMMANDS, NATIVE)
    expect(entries).toHaveLength(3 + REAL_PI_COMMANDS.length)
    expect(byName(entries.slice(0, 3))).toEqual(['compact', 'export', 'name'])
    expect(entries[0]!.origin).toBe('Phosphor')
    expect(entries[0]!.badge).toBe('phosphor')
  })

  it('demotes a host control and says what drives it', () => {
    const entries = buildCommandEntries([...REAL_PI_COMMANDS, RELOAD], [])
    const reload = entries.find((e) => e.name === 'phosphor-reload')!
    expect(reload.demoted).toBe(true)
    expect(reload.description).toContain('Host control')
    expect(reload.description).toContain('before your next message')
  })

  it('carries sourceInfo through for the tooltip', () => {
    const entries = buildCommandEntries(REAL_PI_COMMANDS, [])
    expect(entries.find((e) => e.name === 'websearch')!.sourceInfo?.source).toBe(
      'npm:pi-web-access',
    )
  })
})

describe('filterCommandEntries', () => {
  const entries = buildCommandEntries([...REAL_PI_COMMANDS, ...ALIASED, RELOAD], NATIVE)

  it('lists EVERY entry when nothing is typed — no cap', () => {
    const rows = filterCommandEntries('', entries)
    // 3 native + 13 real + 1 aliased row; the demoted one is left out.
    expect(rows).toHaveLength(17)
    const skills = rows.filter((r) => r.badge === 'skill')
    expect(skills).toHaveLength(6)
  })

  it('browses in badge order with pi order kept inside a group', () => {
    const rows = filterCommandEntries('', entries)
    const badges = rows.map((r) => r.badge)
    const firstIndex = (badge: CommandBadge) => badges.indexOf(badge)
    const lastIndex = (badge: CommandBadge) => badges.lastIndexOf(badge)
    expect(lastIndex('phosphor')).toBeLessThan(firstIndex('extension'))
    expect(lastIndex('extension')).toBeLessThan(firstIndex('skill'))
    expect(byName(rows.filter((r) => r.badge === 'extension'))).toEqual([
      'websearch',
      'curator',
      'google-account',
      'search',
      'mcp',
      'computer-use',
      'llama',
      'status',
    ])
  })

  it('leaves the demoted command out of the browse list but finds it when typed', () => {
    expect(byName(filterCommandEntries('', entries))).not.toContain('phosphor-reload')
    expect(byName(filterCommandEntries('phosphor-reload', entries))).toEqual(['phosphor-reload'])
  })

  it('ranks an exact name first, then a skill that merely contains it', () => {
    const rows = byName(filterCommandEntries('mcp', entries))
    expect(rows[0]).toBe('mcp')
    expect(rows).toContain('skill:snowflake-mcp')
    // `/st` folded into `/status`, so a flat list has one row for both.
    expect(byName(filterCommandEntries('st', entries)).filter((n) => n === 'st')).toEqual([])
  })

  it('finds a skill by its bare name, ahead of anything that merely contains the letters', () => {
    expect(byName(filterCommandEntries('debug', entries))[0]).toBe('skill:debug')
    expect(byName(filterCommandEntries('e2e', entries))[0]).toBe('skill:e2e')
    expect(byName(filterCommandEntries('run', entries))[0]).toBe('skill:run')
  })

  it('still finds a command by its alias', () => {
    expect(byName(filterCommandEntries('st', entries))).toContain('status')
  })

  it('finds a command by a word that appears only in its description', () => {
    const rows = byName(filterCommandEntries('reconnect', entries))
    expect(rows).toContain('mcp')
    expect(rows).not.toContain('websearch')
  })

  it('returns nothing, not a fallback, for a query that matches nothing', () => {
    expect(filterCommandEntries('zzzzzz', entries)).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(byName(filterCommandEntries('MCP', entries))[0]).toBe('mcp')
  })
})

describe('entryTooltip', () => {
  it('carries the whole description, the origin, the path and the aliases', () => {
    const entries = buildCommandEntries([...REAL_PI_COMMANDS, ...ALIASED], [])
    const status = entries.find((e) => e.name === 'status')!
    expect(entryTooltip(status)).toBe(
      [
        'Show the status',
        'From: user · .pi/agent/extensions',
        '/home/dev/.pi/agent/extensions/status.ts',
        'Also: /st',
      ].join('\n'),
    )
  })

  it('omits the pseudo-path of a built-in or inline extension', () => {
    const entries = buildCommandEntries(REAL_PI_COMMANDS, [])
    const llama = entries.find((e) => e.name === 'llama')!
    expect(entryTooltip(llama)).toBe('Manage llama.cpp router models\nFrom: built into pi')
    const mcp = entries.find((e) => e.name === 'mcp')!
    expect(entryTooltip(mcp)).toBe(
      'Manage MCP servers: sign in, reconnect, enable or disable, and change exposure\nFrom: built into pi',
    )
  })
})

function info(path: string) {
  return { path, source: 'local', scope: 'user' as const, origin: 'top-level' as const }
}

/** One handler registered under two names, as an extension may do. */
const ALIASED: RpcSlashCommand[] = [
  {
    name: 'status',
    description: 'Show the status',
    source: 'extension',
    sourceInfo: info('/home/dev/.pi/agent/extensions/status.ts'),
  },
  {
    name: 'st',
    description: 'Show the status',
    source: 'extension',
    sourceInfo: info('/home/dev/.pi/agent/extensions/status.ts'),
  },
]

const RELOAD: RpcSlashCommand = {
  name: 'phosphor-reload',
  description: 'Host control: reload extensions between turns to pick up changed configuration',
  source: 'extension',
  sourceInfo: info('/app/pi-ext/lane-reload.ts'),
}
