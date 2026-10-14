import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mcpConfigPaths,
  projectTrust,
  readMcpConfigs,
  removeMcpServer,
  resolveServers,
  setMcpServerEnabled,
  upsertMcpServer,
  type McpDirs,
} from './mcp-config'

let root: string
let dirs: McpDirs
let workspace: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phosphor-mcp-'))
  dirs = {
    home: join(root, 'home'),
    xdgConfig: join(root, 'xdg'),
    piAgent: join(root, 'pi-agent'),
  }
  workspace = join(root, 'workspace')
  await mkdir(dirs.home, { recursive: true })
  await mkdir(dirs.piAgent, { recursive: true })
  await mkdir(workspace, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (path: string, value: unknown): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const trust = async (folder: string, decision: boolean): Promise<void> =>
  write(join(dirs.piAgent, 'trust.json'), { [await realpath(folder)]: decision })

describe('mcpConfigPaths', () => {
  it('is pi’s global file, plus the project file with a workspace', () => {
    expect(mcpConfigPaths(undefined, dirs)).toEqual([
      { scope: 'global', path: join(dirs.piAgent, 'mcp.json') },
    ])
    expect(mcpConfigPaths(workspace, dirs).map((p) => p.path)).toEqual([
      join(dirs.piAgent, 'mcp.json'),
      join(workspace, '.pi', 'mcp.json'),
    ])
  })
})

describe('resolveServers', () => {
  const paths = { global: 'g.json', project: 'p.json' }

  it('lets a project definition replace a global one whole', () => {
    const { servers } = resolveServers(
      { docs: { url: 'https://a.test/mcp', headers: { Authorization: 'x' } } },
      { docs: { command: 'docs-mcp' } },
      paths,
    )
    expect(servers).toEqual([
      {
        name: 'docs',
        config: { command: 'docs-mcp' },
        defined: { command: 'docs-mcp' },
        scope: 'project',
        replacesGlobal: true,
      },
    ])
  })

  it('applies a project override to enabled and exposure only', () => {
    const { servers, errors } = resolveServers(
      { docs: { url: 'https://a.test/mcp' }, other: { url: 'https://b.test/mcp' } },
      { docs: { enabled: false, exposure: 'direct' }, other: { enabled: false, description: 'x' } },
      paths,
    )
    expect(servers.find((s) => s.name === 'docs')).toEqual({
      name: 'docs',
      config: { url: 'https://a.test/mcp', enabled: false, exposure: 'direct' },
      defined: { url: 'https://a.test/mcp' },
      scope: 'global',
      overridden: true,
    })
    expect(errors).toEqual([
      'p.json: server "other": an override can only set enabled, exposure, toolExposure',
    ])
  })

  it('reports the entries pi would reject instead of listing them', () => {
    const { servers, errors } = resolveServers(
      {
        'bad name': { url: 'https://a.test' },
        sse: { url: 'https://a.test/sse', type: 'sse' as never },
        ftp: { url: 'ftp://a.test' },
        none: {},
        'a-b': { command: 'x' },
        a_b: { command: 'y' },
      },
      { orphan: { enabled: false }, keyed: { url: 'https://k.test', auth: { provider: 'x' } } },
      paths,
    )
    expect(servers.map((s) => s.name)).toEqual(['a-b'])
    expect(errors).toEqual([
      'g.json: invalid server name "bad name" (use letters, digits, "_" and "-")',
      'g.json: server "sse": legacy SSE transport is not supported; use the streamable HTTP URL',
      'g.json: server "ftp": url must be an http or https URL',
      'g.json: server "none" needs either "command" (stdio) or "url" (streamable HTTP)',
      'g.json: server "a_b" conflicts with "a-b"',
      'p.json: server "orphan" needs "command" or "url", or a global server to override',
      'p.json: server "keyed": auth is only allowed in the global mcp.json',
    ])
  })
})

describe('projectTrust', () => {
  it('takes the nearest folder decision from pi’s trust store', async () => {
    await trust(root, true)
    expect(await projectTrust(workspace, dirs)).toMatchObject({
      trusted: true,
      source: 'trust-store',
    })
    await write(join(dirs.piAgent, 'trust.json'), {
      [await realpath(root)]: true,
      [await realpath(workspace)]: false,
    })
    expect((await projectTrust(workspace, dirs)).trusted).toBe(false)
  })

  it('falls back to defaultProjectTrust, which only "always" makes trusted', async () => {
    expect(await projectTrust(workspace, dirs)).toMatchObject({ trusted: false, source: 'default' })
    await write(join(dirs.piAgent, 'settings.json'), { defaultProjectTrust: 'always' })
    expect(await projectTrust(workspace, dirs)).toMatchObject({ trusted: true, source: 'default' })
  })
})

describe('readMcpConfigs', () => {
  it('ignores an untrusted project file, as pi does', async () => {
    await write(join(dirs.piAgent, 'mcp.json'), { mcpServers: { g: { url: 'https://g.test' } } })
    await write(join(workspace, '.pi', 'mcp.json'), { mcpServers: { p: { command: 'p' } } })

    const untrusted = await readMcpConfigs(workspace, dirs)
    expect(untrusted.servers.map((s) => s.name)).toEqual(['g'])
    expect(untrusted.projectTrust?.trusted).toBe(false)
    expect(untrusted.files.map((f) => f.serverNames)).toEqual([['g'], ['p']])

    await trust(workspace, true)
    const trusted = await readMcpConfigs(workspace, dirs)
    expect(trusted.servers.map((s) => s.name)).toEqual(['g', 'p'])
  })

  it('flags pi-mcp-adapter leftovers so Settings offers the migration', async () => {
    expect((await readMcpConfigs(workspace, dirs)).legacy).toBe(false)
    await write(join(dirs.piAgent, 'settings.json'), { extensions: ['-builtin:mcp'] })
    expect((await readMcpConfigs(workspace, dirs)).legacy).toBe(true)
    await write(join(dirs.piAgent, 'settings.json'), {})
    await write(join(workspace, '.pi', 'mcp-adapter.json'), { mcpServers: {} })
    expect((await readMcpConfigs(workspace, dirs)).legacy).toBe(true)
  })

  it('reports a malformed file and resolves the rest', async () => {
    await write(join(dirs.piAgent, 'mcp.json'), '{ nope')
    const result = await readMcpConfigs(undefined, dirs)
    expect(result.files[0]).toMatchObject({ exists: true, malformed: true })
    expect(result.errors[0]).toContain('mcp.json')
    expect(result.servers).toEqual([])
    expect(result.projectTrust).toBeNull()
  })
})

describe('writes', () => {
  const global = (): string => join(dirs.piAgent, 'mcp.json')
  const read = async (path: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>

  it('upserts and removes, keeping unknown top-level keys', async () => {
    await write(global(), { autoEnableCodemode: false, mcpServers: {} })
    await upsertMcpServer('global', undefined, 'docs', { url: 'https://d.test/mcp' }, dirs)
    expect(await read(global())).toEqual({
      autoEnableCodemode: false,
      mcpServers: { docs: { url: 'https://d.test/mcp' } },
    })
    await removeMcpServer('global', undefined, 'docs', dirs)
    expect(await read(global())).toEqual({ autoEnableCodemode: false, mcpServers: {} })
  })

  it('refuses what pi would reject, and a project write without a workspace', async () => {
    await expect(
      upsertMcpServer('global', undefined, 'x y', { command: 'x' }, dirs),
    ).rejects.toThrow('invalid server name')
    await expect(
      upsertMcpServer('global', undefined, 'both', { command: 'x', url: 'https://x.test' }, dirs),
    ).rejects.toThrow('exactly one')
    await expect(
      upsertMcpServer('project', undefined, 'p', { command: 'x' }, dirs),
    ).rejects.toThrow('workspace is required')
  })

  it('never overwrites a malformed file', async () => {
    await write(global(), '{ nope')
    await expect(
      upsertMcpServer('global', undefined, 'docs', { url: 'https://d.test' }, dirs),
    ).rejects.toThrow('will not overwrite')
    expect(await readFile(global(), 'utf8')).toBe('{ nope')
  })

  it('writes enabled as pi does: false is stored, true is the default', async () => {
    await write(global(), { mcpServers: { docs: { url: 'https://d.test' } } })
    await setMcpServerEnabled('global', undefined, 'docs', false, dirs)
    expect(await read(global())).toEqual({
      mcpServers: { docs: { url: 'https://d.test', enabled: false } },
    })
    await setMcpServerEnabled('global', undefined, 'docs', true, dirs)
    expect(await read(global())).toEqual({ mcpServers: { docs: { url: 'https://d.test' } } })
  })

  it('keeps enabled: true in an override, where absence means inherit', async () => {
    const project = join(workspace, '.pi', 'mcp.json')
    await write(project, { mcpServers: { docs: { enabled: false } } })
    await setMcpServerEnabled('project', workspace, 'docs', true, dirs)
    expect(await read(project)).toEqual({ mcpServers: { docs: { enabled: true } } })
  })
})
