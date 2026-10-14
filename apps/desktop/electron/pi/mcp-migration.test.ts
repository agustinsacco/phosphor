import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpDirs } from './mcp-config'
import {
  mergeAdapterEntry,
  planMcpMigration,
  runMcpMigration,
  translateEntry,
} from './mcp-migration'

let root: string
let dirs: McpDirs
let workspace: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phosphor-mcp-migrate-'))
  dirs = { home: join(root, 'home'), xdgConfig: join(root, 'xdg'), piAgent: join(root, 'agent') }
  workspace = join(root, 'workspace')
  for (const dir of [dirs.home, dirs.piAgent, workspace]) await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}
const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

describe('translateEntry', () => {
  it('drops what pi does by itself and keeps what it reads', () => {
    expect(
      translateEntry(
        'linear',
        { url: 'https://mcp.linear.app/mcp', auth: 'oauth', lifecycle: 'lazy-keep-alive' },
        'global',
      ),
    ).toEqual({ config: { url: 'https://mcp.linear.app/mcp' }, notes: [] })
  })

  it('turns a pre-registered OAuth client into pi’s callbackUrl', () => {
    expect(
      translateEntry(
        'slack',
        {
          url: 'https://mcp.slack.com/mcp',
          auth: 'oauth',
          oauth: {
            clientId: '42.1',
            redirectUri: 'http://localhost:19876/callback',
            scope: 'search:read.public',
          },
        },
        'global',
      ),
    ).toEqual({
      config: {
        url: 'https://mcp.slack.com/mcp',
        oauth: {
          clientId: '42.1',
          callbackUrl: 'http://localhost:19876/callback',
          scope: 'search:read.public',
        },
      },
      notes: [],
    })
    const port = translateEntry(
      'x',
      { url: 'https://x.test/mcp', oauth: { redirectUri: 'http://127.0.0.1:{port}/callback' } },
      'global',
    )
    expect(port).toMatchObject({ config: { oauth: { callbackUrl: 'http://127.0.0.1/callback' } } })
    const remote = translateEntry(
      'x',
      {
        url: 'https://x.test/mcp',
        oauth: { redirectUri: 'https://x.test/cb', grantType: 'client_credentials' },
      },
      'global',
    )
    expect(remote).toEqual({
      config: { url: 'https://x.test/mcp' },
      notes: [
        'pi needs a loopback redirect; https://x.test/cb was dropped.',
        'pi has no client-credentials grant; this server signs in through the browser.',
      ],
    })
  })

  it('moves bearer tokens into an Authorization header', () => {
    expect(
      translateEntry(
        'kb',
        {
          url: 'https://kb.test/mcp',
          auth: 'bearer',
          bearerToken: 's3cret',
          caFile: '/ca.pem',
          disabled: true,
        },
        'global',
      ),
    ).toEqual({
      config: {
        url: 'https://kb.test/mcp',
        headers: { Authorization: 'Bearer s3cret' },
        enabled: false,
      },
      notes: [
        'The bearer token is now an Authorization header.',
        'pi has no per-server CA file (/ca.pem); trust it with NODE_EXTRA_CA_CERTS instead.',
      ],
    })
    expect(
      translateEntry('kb', { url: 'https://kb.test', bearerTokenEnv: 'KB_TOKEN' }, 'global'),
    ).toMatchObject({ config: { headers: { Authorization: 'Bearer ${KB_TOKEN}' } } })
  })

  it('maps directTools and tool filters to exposure', () => {
    const base = { command: 'srv' }
    expect(translateEntry('a', { ...base, directTools: true }, 'global')).toMatchObject({
      config: { exposure: 'direct' },
    })
    expect(translateEntry('a', { ...base, directTools: 'search' }, 'global')).toMatchObject({
      config: { exposure: 'deferred' },
    })
    expect(translateEntry('a', { ...base, directTools: false }, 'global')).toEqual({
      config: base,
      notes: [],
    })
    const filtered = translateEntry(
      'a',
      {
        ...base,
        directTools: ['search'],
        includeTools: ['search', 'read'],
        excludeTools: ['drop'],
      },
      'global',
    )
    expect(filtered).toMatchObject({
      config: {
        exposure: 'hidden',
        toolExposure: { search: 'direct', read: 'codemode', drop: 'hidden' },
      },
    })
  })

  it('carries stdio fields and the timeout, and names what it drops', () => {
    expect(
      translateEntry(
        'snow',
        {
          command: 'uvx',
          args: ['snowflake-mcp'],
          env: { A: '1' },
          cwd: '~/w',
          requestTimeoutMs: 1500,
          approveTools: true,
          mystery: 1,
        },
        'global',
      ),
    ).toEqual({
      config: { command: 'uvx', args: ['snowflake-mcp'], env: { A: '1' }, cwd: '~/w', timeout: 2 },
      notes: [
        'pi does not ask before MCP tool calls (approveTools was dropped).',
        'Dropped mystery, which pi does not read.',
      ],
    })
  })

  it('refuses what pi cannot run', () => {
    expect(translateEntry('s', { socket: '/tmp/s.sock' }, 'global')).toHaveProperty('skip')
    expect(translateEntry('bad name', { command: 'x' }, 'global')).toEqual({
      skip: 'invalid server name "bad name" (use letters, digits, "_" and "-")',
    })
    expect(
      translateEntry('p', { url: 'https://p.test', auth: { provider: 'x' } }, 'project'),
    ).toMatchObject({ notes: ['Dropped auth.provider: pi allows it only in the global mcp.json.'] })
  })
})

describe('mergeAdapterEntry', () => {
  it('merges fields, but drops credentials bound to a URL that changed', () => {
    const base = { url: 'https://a.test', headers: { Authorization: 'x' }, directTools: true }
    expect(mergeAdapterEntry(base, { disabled: true })).toEqual({ ...base, disabled: true })
    expect(mergeAdapterEntry(base, { url: 'https://b.test' })).toEqual({
      url: 'https://b.test',
      directTools: true,
    })
    expect(mergeAdapterEntry(base, { command: 'local' })).toEqual({
      command: 'local',
      directTools: true,
    })
  })
})

describe('planMcpMigration', () => {
  it('replays the adapter chain into pi’s files, leaving pi-shaped servers alone', async () => {
    await write(join(dirs.xdgConfig, 'mcp', 'mcp.json'), {
      mcpServers: { shared: { command: 'shared-mcp' } },
    })
    await write(join(dirs.piAgent, 'mcp.json'), {
      mcpServers: { native: { url: 'https://n.test' }, shared: { exposure: 'deferred' } },
    })
    await write(join(dirs.piAgent, 'mcp-adapter.json'), {
      imports: ['cursor'],
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp', auth: 'oauth' },
        shared: { disabled: true },
        mux: { socket: '/tmp/x' },
      },
    })
    await write(join(workspace, '.pi', 'mcp-adapter.json'), {
      mcpServers: { linear: { directTools: true, lifecycle: 'eager' }, local: { command: 'l' } },
    })
    await write(join(dirs.piAgent, 'settings.json'), { extensions: ['-builtin:mcp', 'x.ts'] })

    const plan = await planMcpMigration(workspace, dirs)
    expect(plan.servers.map((s) => [s.scope, s.name, s.config])).toEqual([
      ['global', 'shared', { command: 'shared-mcp', exposure: 'deferred', enabled: false }],
      ['global', 'linear', { url: 'https://mcp.linear.app/mcp' }],
      ['project', 'linear', { exposure: 'direct' }],
      ['project', 'local', { command: 'l' }],
    ])
    expect(plan.skipped.map((s) => s.name)).toEqual(['imports: cursor', 'mux'])
    expect(plan.retire).toEqual([
      join(dirs.piAgent, 'mcp-adapter.json'),
      join(workspace, '.pi', 'mcp-adapter.json'),
    ])
    expect(plan.builtinDisabled).toBe(true)
    expect(plan.blocked).toEqual([])
  })

  it('translates adapter entries in pi’s own mcp.json, which the adapter read too', async () => {
    // Older adapters kept their config in pi's mcp.json; pi rejects `auth: "oauth"`.
    await write(join(dirs.piAgent, 'mcp.json'), {
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp', auth: 'oauth', lifecycle: 'eager' },
        native: { url: 'https://n.test', exposure: 'direct' },
      },
    })
    await write(join(dirs.piAgent, 'settings.json'), { extensions: ['-builtin:mcp'] })

    const plan = await planMcpMigration(undefined, dirs)
    expect(plan.servers.map((s) => [s.name, s.config])).toEqual([
      ['linear', { url: 'https://mcp.linear.app/mcp' }],
    ])
    await runMcpMigration(undefined, dirs)
    expect(await read(join(dirs.piAgent, 'mcp.json'))).toEqual({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp' },
        native: { url: 'https://n.test', exposure: 'direct' },
      },
    })
  })

  it('after the move, plans only a project that still has an adapter file', async () => {
    // pi's MCP is on and the global adapter file is gone, but a shared file
    // still names a server the user removed from pi's config since.
    await write(join(dirs.xdgConfig, 'mcp', 'mcp.json'), {
      mcpServers: { removed: { command: 'gone' } },
    })
    await write(join(dirs.piAgent, 'settings.json'), { extensions: [] })
    await write(join(workspace, '.pi', 'mcp-adapter.json'), {
      mcpServers: { local: { command: 'l', lifecycle: 'eager' } },
    })

    const plan = await planMcpMigration(workspace, dirs)
    expect(plan.servers.map((s) => [s.scope, s.name])).toEqual([['project', 'local']])
    expect(plan.retire).toEqual([join(workspace, '.pi', 'mcp-adapter.json')])
  })

  it('blocks on a file it cannot read', async () => {
    await write(join(dirs.piAgent, 'mcp-adapter.json'), '{ nope')
    expect((await planMcpMigration(undefined, dirs)).blocked).toEqual([
      join(dirs.piAgent, 'mcp-adapter.json'),
    ])
    await expect(runMcpMigration(undefined, dirs)).rejects.toThrow('not valid JSON')
  })
})

describe('runMcpMigration', () => {
  it('writes pi’s file, backs everything up, and turns the built-in back on', async () => {
    const now = new Date('2026-10-14T10:00:00.000Z')
    const suffix = '2026-10-14T10-00-00-000Z'
    await write(join(dirs.piAgent, 'mcp.json'), {
      autoEnableCodemode: false,
      mcpServers: { native: { url: 'https://n.test' } },
    })
    await write(join(dirs.piAgent, 'mcp-adapter.json'), {
      mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', auth: 'oauth' } },
    })
    await write(join(dirs.piAgent, 'settings.json'), {
      packages: ['npm:pi-mcp-adapter'],
      extensions: ['-builtin:mcp'],
    })

    const result = await runMcpMigration(undefined, dirs, now)

    expect(await read(join(dirs.piAgent, 'mcp.json'))).toEqual({
      autoEnableCodemode: false,
      mcpServers: {
        native: { url: 'https://n.test' },
        linear: { url: 'https://mcp.linear.app/mcp' },
      },
    })
    expect(await read(join(dirs.piAgent, 'settings.json'))).toEqual({
      packages: ['npm:pi-mcp-adapter'],
      extensions: [],
    })
    expect((await readdir(dirs.piAgent)).sort()).toEqual([
      'mcp-adapter.json.migrated-' + suffix,
      'mcp.json',
      'mcp.json.bak-' + suffix,
      'settings.json',
      'settings.json.bak-' + suffix,
    ])
    expect(result.written).toEqual([
      join(dirs.piAgent, 'mcp.json'),
      join(dirs.piAgent, 'settings.json'),
    ])

    // Run again: nothing left to do, nothing touched.
    const again = await runMcpMigration(undefined, dirs, now)
    expect(again).toEqual({ written: [], backups: [] })
  })

  it('never writes the shared files it read', async () => {
    const shared = join(dirs.home, '.agents', 'mcp.json')
    await write(shared, { mcpServers: { s: { command: 's' } } })
    await write(join(dirs.piAgent, 'settings.json'), { extensions: ['-builtin:mcp'] })
    const before = await readFile(shared, 'utf8')
    await runMcpMigration(undefined, dirs)
    expect(await readFile(shared, 'utf8')).toBe(before)
    expect(await read(join(dirs.piAgent, 'mcp.json'))).toEqual({
      mcpServers: { s: { command: 's' } },
    })
  })
})
