import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { McpDirs } from './mcp-config'
import {
  adapterSources,
  buildPlan,
  mergeAdapterEntry,
  planMcpMigration,
  runMcpMigration,
  translateEntry,
  type ReadSource,
} from './mcp-migration'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    rename: vi.fn(actual.rename),
    writeFile: vi.fn(actual.writeFile),
  }
})

let root: string
let dirs: McpDirs
let workspace: string

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'mcp-migration-characterization-'))
  dirs = { home: join(root, 'home'), xdgConfig: join(root, 'xdg'), piAgent: join(root, 'agent') }
  workspace = join(root, 'workspace')
})

afterEach(async () => {
  vi.clearAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

async function write(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function sources(): ReadSource[] {
  return adapterSources(workspace, dirs).map((source) => ({
    ...source,
    exists: source.target || source.owned,
    malformed: false,
    raw: {},
  }))
}

describe('MCP migration characterization through the facade', () => {
  it('replays precedence while resetting credentials on URL and transport changes', () => {
    const base = {
      url: 'https://old.test',
      headers: { Authorization: 'secret' },
      auth: { provider: 'old' },
      oauth: { clientId: 'old' },
      bearerTokenEnv: 'OLD',
      requestHeadersCommand: 'secret',
      caFile: '/old.pem',
      exposure: 'direct',
    }
    expect(mergeAdapterEntry(base, { url: 'https://new.test' })).toEqual({
      url: 'https://new.test',
      exposure: 'direct',
    })
    expect(mergeAdapterEntry(base, { command: 'local', args: ['x'] })).toEqual({
      command: 'local',
      args: ['x'],
      exposure: 'direct',
    })
    expect(
      mergeAdapterEntry(
        { command: 'local', args: ['x'], env: { A: '1' }, cwd: '/a' },
        {
          url: 'https://new.test',
        },
      ),
    ).toEqual({ url: 'https://new.test' })
    expect(mergeAdapterEntry(base, { url: base.url, disabled: true })).toEqual({
      ...base,
      disabled: true,
    })
  })

  it('keeps project auth restrictions and the complete translation note order', () => {
    expect(
      translateEntry(
        'server',
        {
          url: 'https://server.test',
          auth: { provider: 'provider' },
          bearerTokenStore: true,
          requestHeadersCommand: 'headers',
          caFile: '/ca.pem',
          oauth: { redirectUri: 'https://remote.test', grantType: 'client_credentials', extra: 1 },
          inheritEnv: false,
          includeTools: ['read'],
          approveTools: true,
          unknownFirst: 1,
          unknownSecond: 2,
        },
        'project',
      ),
    ).toEqual({
      config: {
        url: 'https://server.test',
        exposure: 'hidden',
        toolExposure: { read: 'codemode' },
      },
      notes: [
        'Dropped auth.provider: pi allows it only in the global mcp.json.',
        "The bearer token was in the adapter's credential store; add an Authorization header.",
        'pi cannot run a command for request headers; set them under headers.',
        'pi has no per-server CA file (/ca.pem); trust it with NODE_EXTRA_CA_CERTS instead.',
        'pi needs a loopback redirect; https://remote.test was dropped.',
        'pi has no client-credentials grant; this server signs in through the browser.',
        'Dropped oauth.extra, which pi does not support.',
        'pi always passes its environment to a local server (inheritEnv: false was dropped).',
        "Tool filters became toolExposure rules; they match the server's own tool names.",
        'pi does not ask before MCP tool calls (approveTools was dropped).',
        'Dropped unknownFirst, unknownSecond, which pi does not read.',
      ],
    })
  })

  it('keeps source chains, project partials and namespace collision ordering', () => {
    const chain = sources()
    chain[0]!.exists = true
    chain[0]!.raw = { mcpServers: { 'a-b': { command: 'lower', args: ['low'] } } }
    chain[4]!.raw = { mcpServers: { 'a-b': { command: 'higher' }, a_b: { command: 'clash' } } }
    chain[7]!.raw = { mcpServers: { 'a-b': { disabled: true, directTools: 'search' } } }
    const plan = buildPlan(chain, {})
    expect(plan.servers).toEqual([
      {
        name: 'a-b',
        scope: 'global',
        sources: [chain[0]!.path, chain[4]!.path],
        config: { command: 'higher', args: ['low'] },
        notes: [],
      },
      {
        name: 'a-b',
        scope: 'project',
        sources: [chain[7]!.path],
        config: { enabled: false, exposure: 'deferred' },
        notes: [],
      },
    ])
    expect(plan.skipped).toEqual([
      { name: 'a_b', source: chain[4]!.path, reason: 'Its tool names would collide with "a-b".' },
    ])
  })

  it('reserves already-pi namespaces without rewriting their entries', () => {
    const chain = sources()
    chain[3]!.raw = { mcpServers: { 'native-server': { command: 'native' } } }
    chain[4]!.raw = { mcpServers: { native_server: { command: 'adapter' } } }
    const plan = buildPlan(chain, {})
    expect(plan.servers).toEqual([])
    expect(plan.skipped).toEqual([
      {
        name: 'native_server',
        source: chain[4]!.path,
        reason: 'Its tool names would collide with "native-server".',
      },
    ])
  })

  it('recomputes at write time and becomes idempotent without touching shared files or trust', async () => {
    const adapter = join(dirs.piAgent, 'mcp-adapter.json')
    const shared = join(workspace, '.mcp.json')
    const trust = join(dirs.piAgent, 'trust.json')
    await write(adapter, { mcpServers: { server: { command: 'before' } } })
    await write(shared, { mcpServers: { shared: { command: 'shared' } } })
    await write(trust, { [workspace]: false })
    const sharedBefore = await fs.readFile(shared, 'utf8')
    expect((await planMcpMigration(workspace, dirs)).servers[0]!.config.command).toBe('before')
    await write(adapter, { mcpServers: { server: { command: 'after' } } })
    await runMcpMigration(workspace, dirs)
    const target = JSON.parse(await fs.readFile(join(dirs.piAgent, 'mcp.json'), 'utf8'))
    expect(target.mcpServers.server).toEqual({ command: 'after' })
    expect(await fs.readFile(shared, 'utf8')).toBe(sharedBefore)
    expect(JSON.parse(await fs.readFile(trust, 'utf8'))).toEqual({ [workspace]: false })
    expect(await runMcpMigration(workspace, dirs)).toEqual({ written: [], backups: [] })
  })

  it('backs up targets before writing, retires adapters next, then restores builtin MCP', async () => {
    const target = join(dirs.piAgent, 'mcp.json')
    const adapter = join(dirs.piAgent, 'mcp-adapter.json')
    const settings = join(dirs.piAgent, 'settings.json')
    await write(target, { mcpServers: { native: { command: 'native' } }, other: true })
    await write(adapter, { mcpServers: { added: { command: 'added' } } })
    await write(settings, { extensions: ['!builtin:mcp', '-builtin:mcp', 'keep'] })
    vi.clearAllMocks()
    const result = await runMcpMigration(undefined, dirs, new Date('2026-01-02T03:04:05Z'))
    expect(result.backups).toEqual([
      { from: target, to: `${target}.bak-2026-01-02T03-04-05-000Z` },
      { from: adapter, to: `${adapter}.migrated-2026-01-02T03-04-05-000Z` },
      { from: settings, to: `${settings}.bak-2026-01-02T03-04-05-000Z` },
    ])
    const copies = vi.mocked(fs.copyFile).mock.invocationCallOrder
    const writes = vi.mocked(fs.writeFile).mock.invocationCallOrder
    const moves = vi.mocked(fs.rename).mock.invocationCallOrder
    expect(copies[0]).toBeLessThan(writes[0]!)
    expect(writes[0]).toBeLessThan(moves[0]!)
    expect(moves[0]).toBeLessThan(copies[1]!)
    expect(copies[1]).toBeLessThan(writes[1]!)
    expect(JSON.parse(await fs.readFile(result.backups[0]!.to, 'utf8'))).toEqual({
      mcpServers: { native: { command: 'native' } },
      other: true,
    })
    expect(JSON.parse(await fs.readFile(settings, 'utf8'))).toEqual({ extensions: ['keep'] })
  })

  it.each(['adapter', 'settings', 'shared'])(
    'malformed %s blocks all writes and retirement',
    async (bad) => {
      const adapter = join(dirs.piAgent, 'mcp-adapter.json')
      const settings = join(dirs.piAgent, 'settings.json')
      const shared = join(dirs.xdgConfig, 'mcp', 'mcp.json')
      await write(adapter, { mcpServers: { server: { command: 'server' } } })
      await write(settings, { extensions: ['-builtin:mcp'] })
      const paths = { adapter, settings, shared }
      await write(paths[bad as keyof typeof paths], '{ broken')
      vi.clearAllMocks()
      expect((await planMcpMigration(workspace, dirs)).blocked).toEqual([
        paths[bad as keyof typeof paths],
      ])
      await expect(runMcpMigration(workspace, dirs)).rejects.toThrow('not valid JSON')
      expect(fs.writeFile).not.toHaveBeenCalled()
      expect(fs.copyFile).not.toHaveBeenCalled()
      expect(fs.rename).not.toHaveBeenCalled()
    },
  )
})
