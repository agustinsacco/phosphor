import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mcpConfigPaths,
  readMcpCache,
  readMcpConfigs,
  removeMcpServer,
  setMcpServerDisabled,
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
  await writeFile(path, JSON.stringify(value, null, 2))
}

describe('mcpConfigPaths', () => {
  it('orders the chain lowest → highest and honors XDG', () => {
    const paths = mcpConfigPaths(workspace, dirs)
    expect(paths.map((p) => p.scope)).toEqual([
      'xdg',
      'agents',
      'agents-dir',
      'pi-global',
      'project',
      'pi-project',
    ])
    expect(paths[0]?.path).toBe(join(dirs.xdgConfig, 'mcp', 'mcp.json'))
    expect(paths[3]?.path).toBe(join(dirs.piAgent, 'mcp.json'))
  })

  it('omits project scopes without a workspace', () => {
    const scopes = mcpConfigPaths(undefined, dirs).map((p) => p.scope)
    expect(scopes).toEqual(['xdg', 'agents', 'agents-dir', 'pi-global'])
  })
})

describe('readMcpConfigs', () => {
  it('resolves precedence with shadows recorded', async () => {
    await write(join(dirs.piAgent, 'mcp.json'), {
      mcpServers: { shared: { url: 'https://global.example' }, only: { url: 'https://x' } },
    })
    await write(join(workspace, '.pi', 'mcp.json'), {
      mcpServers: { shared: { url: 'https://project.example' } },
    })

    const { servers, files } = await readMcpConfigs(workspace, dirs)
    const shared = servers.find((s) => s.name === 'shared')
    expect(shared?.scope).toBe('pi-project')
    expect(shared?.config.url).toBe('https://project.example')
    expect(shared?.shadows).toEqual(['pi-global'])
    expect(servers.find((s) => s.name === 'only')?.scope).toBe('pi-global')
    expect(files.find((f) => f.scope === 'pi-global')?.serverNames).toContain('shared')
  })

  it('reports malformed files without failing the whole read', async () => {
    await writeFile(join(dirs.piAgent, 'mcp.json'), '{ not json')
    const { files, servers } = await readMcpConfigs(workspace, dirs)
    expect(files.find((f) => f.scope === 'pi-global')?.malformed).toBe(true)
    expect(servers).toEqual([])
  })
})

describe('mutations', () => {
  it('upsert creates dirs, preserves unknown keys, validates input', async () => {
    await write(join(dirs.piAgent, 'mcp.json'), {
      customTopLevel: { keep: true },
      mcpServers: {},
    })
    await upsertMcpServer('pi-global', undefined, 'linear', { url: 'https://linear' }, dirs)
    const parsed = JSON.parse(await readFile(join(dirs.piAgent, 'mcp.json'), 'utf8'))
    expect(parsed.customTopLevel).toEqual({ keep: true })
    expect(parsed.mcpServers.linear.url).toBe('https://linear')

    // Fresh project file (dir does not exist yet).
    await upsertMcpServer('pi-project', workspace, 'local', { command: 'npx', args: ['x'] }, dirs)
    const project = JSON.parse(await readFile(join(workspace, '.pi', 'mcp.json'), 'utf8'))
    expect(project.mcpServers.local.command).toBe('npx')

    await expect(
      upsertMcpServer('pi-global', undefined, 'bad', { url: 'https://x', command: 'y' }, dirs),
    ).rejects.toThrow(/exactly one/)
    await expect(
      upsertMcpServer('pi-global', undefined, 'a/b', { url: 'https://x' }, dirs),
    ).rejects.toThrow(/Invalid MCP server name/)
  })

  it('refuses writes over malformed files', async () => {
    await writeFile(join(dirs.piAgent, 'mcp.json'), '{ nope')
    await expect(
      upsertMcpServer('pi-global', undefined, 'x', { url: 'https://x' }, dirs),
    ).rejects.toThrow(/not valid JSON/)
  })

  it('toggles disabled in place and removes servers', async () => {
    await write(join(dirs.piAgent, 'mcp.json'), {
      mcpServers: { linear: { url: 'https://linear' } },
    })
    await setMcpServerDisabled('pi-global', undefined, 'linear', true, dirs)
    let parsed = JSON.parse(await readFile(join(dirs.piAgent, 'mcp.json'), 'utf8'))
    expect(parsed.mcpServers.linear.disabled).toBe(true)

    await setMcpServerDisabled('pi-global', undefined, 'linear', false, dirs)
    parsed = JSON.parse(await readFile(join(dirs.piAgent, 'mcp.json'), 'utf8'))
    expect('disabled' in parsed.mcpServers.linear).toBe(false)

    await removeMcpServer('pi-global', undefined, 'linear', dirs)
    parsed = JSON.parse(await readFile(join(dirs.piAgent, 'mcp.json'), 'utf8'))
    expect(parsed.mcpServers).toEqual({})
  })
})

describe('readMcpCache', () => {
  it('scrapes tool lists tolerantly and returns [] for junk', async () => {
    await write(join(dirs.piAgent, 'mcp-cache.json'), {
      servers: {
        linear: { tools: [{ name: 'get_issue' }, 'save_issue', 42] },
        broken: { tools: 'nope' },
      },
    })
    const entries = await readMcpCache(dirs)
    expect(entries).toEqual([{ name: 'linear', tools: ['get_issue', 'save_issue'] }])

    await writeFile(join(dirs.piAgent, 'mcp-cache.json'), 'garbage')
    expect(await readMcpCache(dirs)).toEqual([])
  })
})
