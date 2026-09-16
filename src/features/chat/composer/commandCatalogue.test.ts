import { describe, expect, it } from 'vitest'
import {
  badgeFor,
  buildCommandEntries,
  dedupeAliases,
  entryTooltip,
  filterCommandEntries,
  mcpPromptServer,
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

describe('mcpPromptServer', () => {
  it('reads the server out of the adapter naming scheme', () => {
    expect(mcpPromptServer('mcp__notion__make-this-a-notion-page')).toBe('notion')
    expect(mcpPromptServer('mcp__my_server__do-it')).toBe('my_server')
  })

  it('is null for anything else, including the adapter status commands', () => {
    expect(mcpPromptServer('mcp')).toBeNull()
    expect(mcpPromptServer('mcp-auth')).toBeNull()
    expect(mcpPromptServer('pi-mcp')).toBeNull()
    expect(mcpPromptServer('mcp__')).toBeNull()
  })
})

describe('originLabel', () => {
  const find = (name: string) => REAL_PI_COMMANDS.find((c) => c.name === name)!

  it('names the package for a package command', () => {
    expect(originLabel(find('websearch'))).toBe('pi-web-access')
    expect(originLabel(find('computer-use'))).toBe('@injaneity/pi-computer-use')
  })

  it('names the server for an MCP prompt, not the adapter that relays it', () => {
    expect(originLabel(find('mcp__notion__make-this-a-notion-page'))).toBe('notion · MCP prompt')
  })

  it("says built into pi for pi's inline extensions", () => {
    expect(originLabel(find('llama'))).toBe('built into pi')
  })

  it('gives a local skill its scope and root', () => {
    expect(originLabel(find('skill:debug'))).toBe('project · .claude/skills')
    expect(originLabel(find('skill:test-augie-e2e-slack'))).toBe('user · .claude/skills')
    expect(originLabel(find('skill:game-builder'))).toBe('user · .pi/agent/skills')
  })

  it('names the package for a skill bundled in one', () => {
    expect(originLabel(find('skill:mcp-scripting'))).toBe('pi-mcp-adapter')
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

describe('badgeFor', () => {
  it("corrects the adapter's MCP prompts to prompt, and leaves everything else as pi said", () => {
    const find = (name: string) => REAL_PI_COMMANDS.find((c) => c.name === name)!
    expect(badgeFor(find('mcp__notion__make-this-a-notion-page'))).toBe('prompt')
    expect(badgeFor(find('mcp'))).toBe('extension')
    expect(badgeFor(find('skill:debug'))).toBe('skill')
  })
})

describe('dedupeAliases', () => {
  it('folds two names from one file with one description into one row', () => {
    const rows = dedupeAliases(REAL_PI_COMMANDS)
    expect(rows).toHaveLength(REAL_PI_COMMANDS.length - 1)
    const mcp = rows.find((r) => r.command.name === 'mcp')!
    expect(mcp.aliases).toEqual(['pi-mcp'])
    expect(rows.some((r) => r.command.name === 'pi-mcp')).toBe(false)
  })

  it('keeps the first registration as the row', () => {
    const rows = dedupeAliases([
      { name: 'b', description: 'same', source: 'extension', sourceInfo: info('/x.ts') },
      { name: 'a', description: 'same', source: 'extension', sourceInfo: info('/x.ts') },
    ])
    expect(byName(rows.map((r) => r.command))).toEqual(['b'])
    expect(rows[0]!.aliases).toEqual(['a'])
  })

  it('does not fold same-file commands whose descriptions differ (the two Notion prompts)', () => {
    const rows = dedupeAliases(REAL_PI_COMMANDS)
    expect(rows.filter((r) => r.command.name.startsWith('mcp__notion__'))).toHaveLength(2)
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
    expect(entries).toHaveLength(3 + REAL_PI_COMMANDS.length - 1)
    expect(byName(entries.slice(0, 3))).toEqual(['compact', 'export', 'name'])
    expect(entries[0]!.origin).toBe('Phosphor')
    expect(entries[0]!.badge).toBe('phosphor')
  })

  it('demotes /mcp-auth and says where Phosphor drives it from', () => {
    const entries = buildCommandEntries(REAL_PI_COMMANDS, [])
    const auth = entries.find((e) => e.name === 'mcp-auth')!
    expect(auth.demoted).toBe(true)
    expect(auth.description).toContain('Authenticate with an MCP server (OAuth)')
    expect(auth.description).toContain('Settings ▸ MCP Connectors')
  })

  it('carries sourceInfo through for the tooltip', () => {
    const entries = buildCommandEntries(REAL_PI_COMMANDS, [])
    expect(entries.find((e) => e.name === 'websearch')!.sourceInfo?.source).toBe(
      'npm:pi-web-access',
    )
  })
})

describe('filterCommandEntries', () => {
  const entries = buildCommandEntries(REAL_PI_COMMANDS, NATIVE)

  it('lists EVERY entry when nothing is typed — no cap', () => {
    const rows = filterCommandEntries('', entries)
    // 3 native + 17 pi rows (18 minus the folded alias) minus the demoted one.
    expect(rows).toHaveLength(19)
    const skills = rows.filter((r) => r.badge === 'skill')
    expect(skills).toHaveLength(7)
  })

  it('browses in badge order with pi order kept inside a group', () => {
    const rows = filterCommandEntries('', entries)
    const badges = rows.map((r) => r.badge)
    const firstIndex = (badge: CommandBadge) => badges.indexOf(badge)
    const lastIndex = (badge: CommandBadge) => badges.lastIndexOf(badge)
    expect(lastIndex('phosphor')).toBeLessThan(firstIndex('extension'))
    expect(lastIndex('extension')).toBeLessThan(firstIndex('prompt'))
    expect(lastIndex('prompt')).toBeLessThan(firstIndex('skill'))
    expect(byName(rows.filter((r) => r.badge === 'extension'))).toEqual([
      'websearch',
      'curator',
      'google-account',
      'search',
      'mcp',
      'computer-use',
      'llama',
    ])
  })

  it('leaves the demoted command out of the browse list but finds it when typed', () => {
    expect(byName(filterCommandEntries('', entries))).not.toContain('mcp-auth')
    // First by prefix; the Notion prompts follow as subsequence matches.
    expect(byName(filterCommandEntries('mcp-a', entries))[0]).toBe('mcp-auth')
    expect(byName(filterCommandEntries('mcp-auth', entries))).toEqual(['mcp-auth'])
  })

  it('ranks an exact name first, then prefixes, then the alias match', () => {
    const rows = byName(filterCommandEntries('mcp', entries))
    expect(rows[0]).toBe('mcp')
    expect(rows.indexOf('mcp-auth')).toBeLessThan(rows.indexOf('skill:mcp-scripting'))
    // `/pi-mcp` folded into `/mcp`, so a flat list has one MCP status row.
    expect(rows.filter((n) => n === 'mcp' || n === 'pi-mcp')).toEqual(['mcp'])
  })

  it('finds a skill by its bare name, ahead of anything that merely contains the letters', () => {
    expect(byName(filterCommandEntries('debug', entries))[0]).toBe('skill:debug')
    expect(byName(filterCommandEntries('e2e', entries))[0]).toBe('skill:e2e')
    expect(byName(filterCommandEntries('run', entries))[0]).toBe('skill:run')
  })

  it('still finds a command by its alias', () => {
    expect(byName(filterCommandEntries('pi-mcp', entries))).toContain('mcp')
  })

  it('finds a command by a word that appears only in its description', () => {
    const rows = byName(filterCommandEntries('status', entries))
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
    const entries = buildCommandEntries(REAL_PI_COMMANDS, [])
    const mcp = entries.find((e) => e.name === 'mcp')!
    expect(entryTooltip(mcp)).toBe(
      [
        'Show MCP server status',
        'From: pi-mcp-adapter',
        '/home/dev/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts',
        'Also: /pi-mcp',
      ].join('\n'),
    )
  })

  it('omits the pseudo-path of an inline extension', () => {
    const entries = buildCommandEntries(REAL_PI_COMMANDS, [])
    const llama = entries.find((e) => e.name === 'llama')!
    expect(entryTooltip(llama)).toBe('Manage llama.cpp router models\nFrom: built into pi')
  })
})

function info(path: string) {
  return { path, source: 'local', scope: 'user' as const, origin: 'top-level' as const }
}
