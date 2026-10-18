import { describe, expect, it } from 'vitest'
import type { McpScope } from '@shared/mcp'
import { adapterSources, buildPlan, type ReadSource } from './mcp-migration-plan'

const dirs = { home: '/home/user', xdgConfig: '/config', piAgent: '/agent' }
const workspace = '/workspace'

function chain(): ReadSource[] {
  return adapterSources(workspace, dirs).map((source) => ({
    ...source,
    exists: false,
    malformed: false,
    raw: {},
  }))
}

function withEntries(
  sources: ReadSource[],
  index: number,
  mcpServers: Record<string, unknown>,
): void {
  sources[index] = { ...sources[index]!, exists: true, raw: { mcpServers } }
}

describe('adapterSources', () => {
  it('lists the complete low-to-high precedence chain with ownership and target flags', () => {
    expect(adapterSources(workspace, dirs)).toEqual([
      { path: '/config/mcp/mcp.json', scope: 'global', owned: false, target: false },
      { path: '/home/user/.agents/mcp.json', scope: 'global', owned: false, target: false },
      { path: '/home/user/.agents/mcp/mcp.json', scope: 'global', owned: false, target: false },
      { path: '/agent/mcp.json', scope: 'global', owned: false, target: true },
      { path: '/agent/mcp-adapter.json', scope: 'global', owned: true, target: false },
      { path: '/workspace/.mcp.json', scope: 'project', owned: false, target: false },
      { path: '/workspace/.pi/mcp.json', scope: 'project', owned: false, target: true },
      { path: '/workspace/.pi/mcp-adapter.json', scope: 'project', owned: true, target: false },
    ])
    expect(adapterSources(undefined, dirs)).toEqual(adapterSources(workspace, dirs).slice(0, 5))
  })
})

describe('buildPlan scope eligibility', () => {
  it.each<[string, number[], unknown, McpScope[]]>([
    ['no adapter', [], {}, []],
    ['global adapter', [4], {}, ['global', 'project']],
    ['project adapter', [7], {}, ['project']],
    ['disabled builtin', [], { extensions: ['-builtin:mcp'] }, ['global', 'project']],
    ['alternate disabled builtin', [], { extensions: ['!builtin:mcp'] }, ['global', 'project']],
  ])('plans only eligible scopes with %s', (_name, owned, settings, expected) => {
    const sources = chain()
    withEntries(sources, 0, { global: { command: 'global' } })
    withEntries(sources, 5, { project: { command: 'project' } })
    for (const index of owned) sources[index]!.exists = true
    const plan = buildPlan(sources, settings)
    expect(plan.servers.map((server) => server.scope)).toEqual(expected)
    expect(plan.retire).toEqual(owned.map((index) => sources[index]!.path))
  })

  it('reports malformed sources in source order without changing the source data', () => {
    const sources = chain()
    sources[0]!.malformed = true
    sources[7]!.malformed = true
    const before = structuredClone(sources)
    expect(buildPlan(sources, null)).toEqual({
      servers: [],
      skipped: [],
      retire: [],
      builtinDisabled: false,
      blocked: [sources[0]!.path, sources[7]!.path],
    })
    expect(sources).toEqual(before)
  })
})

describe('buildPlan merging and collisions', () => {
  it('merges every source in order without merging global entries into project overrides', () => {
    const sources = chain()
    for (let index = 0; index < 5; index++) {
      withEntries(sources, index, {
        server: { command: `command-${index}`, args: [`arg-${index}`] },
      })
    }
    withEntries(sources, 5, { server: { disabled: true } })
    withEntries(sources, 6, { server: { exposure: 'deferred' } })
    withEntries(sources, 7, { server: { directTools: true } })
    expect(buildPlan(sources, {}).servers).toEqual([
      {
        name: 'server',
        scope: 'global',
        sources: sources.slice(0, 5).map((s) => s.path),
        config: { command: 'command-4', args: ['arg-4'] },
        notes: [],
      },
      {
        name: 'server',
        scope: 'project',
        sources: sources.slice(5).map((s) => s.path),
        config: { enabled: false, exposure: 'direct' },
        notes: [],
      },
    ])
  })

  it('leaves pi-only entries alone but translates changed or shared entries', () => {
    const sources = chain()
    withEntries(sources, 0, { shared: { command: 'shared' } })
    withEntries(sources, 3, {
      native: { command: 'native' },
      changed: { command: 'changed', lifecycle: 'eager' },
    })
    sources[4]!.exists = true
    withEntries(sources, 6, { native: { enabled: false, exposure: 'direct' } })
    expect(buildPlan(sources, {}).servers.map((server) => server.name)).toEqual([
      'shared',
      'changed',
    ])
  })

  it('reports imports from owned sources only and ignores non-object server entries', () => {
    const sources = chain()
    sources[0] = { ...sources[0]!, exists: true, raw: { imports: ['shared-app'], mcpServers: [] } }
    sources[4] = {
      ...sources[4]!,
      exists: true,
      raw: {
        imports: ['cursor', 'claude'],
        mcpServers: { ignored: null, alsoIgnored: [], scalar: 'text', valid: { command: 'valid' } },
      },
    }
    const plan = buildPlan(sources, {})
    expect(plan.servers.map((server) => server.name)).toEqual(['valid'])
    expect(plan.skipped).toEqual([
      {
        name: 'imports: cursor, claude',
        source: sources[4]!.path,
        reason: 'Servers imported from other apps are not copied; add them in Settings.',
      },
    ])
  })

  it('allows same-name project replacement but rejects normalized collisions across scopes', () => {
    const sources = chain()
    withEntries(sources, 4, { 'a-b': { command: 'global' }, invalid: { socket: '/socket' } })
    withEntries(sources, 7, {
      'a-b': { command: 'project' },
      a_b: { command: 'collision' },
      invalid: { command: 'now-valid' },
    })
    const plan = buildPlan(sources, {})
    expect(plan.servers.map((server) => [server.name, server.config.command])).toEqual([
      ['a-b', 'global'],
      ['a-b', 'project'],
      ['invalid', 'now-valid'],
    ])
    expect(plan.skipped).toEqual([
      {
        name: 'invalid',
        source: sources[4]!.path,
        reason:
          'pi cannot connect to an rmcp-mux socket; add the server again with a command or URL.',
      },
      { name: 'a_b', source: sources[7]!.path, reason: 'Its tool names would collide with "a-b".' },
    ])
  })
})

describe('buildPlan partial overrides', () => {
  it('refuses global partials and project partials containing no usable settings', () => {
    const sources = chain()
    withEntries(sources, 4, { global: { disabled: true } })
    withEntries(sources, 7, { project: { lifecycle: 'eager' } })
    expect(buildPlan(sources, {}).skipped).toEqual([
      { name: 'global', source: sources[4]!.path, reason: 'It has no command or url.' },
      {
        name: 'project',
        source: sources[7]!.path,
        reason: 'It only changed settings pi does not have.',
      },
    ])
  })

  it('applies disabled and direct-list precedence and names dropped fields in order', () => {
    const sources = chain()
    withEntries(sources, 7, {
      server: {
        enabled: false,
        disabled: false,
        exposure: 'codemode',
        directTools: ['read', 3],
        toolExposure: { read: 'hidden', keep: 'deferred' },
        lifecycle: 'eager',
        includeTools: ['read'],
        unknown: true,
      },
    })
    expect(buildPlan(sources, {}).servers).toEqual([
      {
        name: 'server',
        scope: 'project',
        sources: [sources[7]!.path],
        config: {
          enabled: true,
          exposure: 'codemode',
          toolExposure: { read: 'direct', keep: 'deferred' },
        },
        notes: [
          'A project override can only change enabled and exposure; dropped includeTools, unknown.',
        ],
      },
    ])
  })

  it.each([
    ['search', 'deferred'],
    [true, 'direct'],
  ])('maps partial directTools %s over explicit exposure', (directTools, exposure) => {
    const sources = chain()
    withEntries(sources, 7, { server: { exposure: 'hidden', directTools } })
    expect(buildPlan(sources, {}).servers[0]!.config).toEqual({ exposure })
  })
})
