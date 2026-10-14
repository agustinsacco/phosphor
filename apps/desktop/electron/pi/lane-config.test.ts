import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneConfigFingerprint, laneConfigFiles } from './lane-config'
import type { McpDirs } from './mcp-config'

const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'phosphor-lane-config-'))
  cleanups.push(root)
  const dirs: McpDirs = {
    home: join(root, 'home'),
    xdgConfig: join(root, 'home', '.config'),
    piAgent: join(root, 'home', '.pi', 'agent'),
  }
  const lane = join(root, 'lane')
  const other = join(root, 'other')
  for (const dir of [dirs.piAgent, lane, other]) await mkdir(dir, { recursive: true })
  return { dirs, lane, other, fingerprint: createLaneConfigFingerprint(() => dirs) }
}

const write = (path: string, value: unknown) =>
  writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2))

describe('laneConfigFiles', () => {
  it('is the two mcp.json files and the two settings.json files pi reads', async () => {
    const { dirs, lane } = await setup()
    expect(laneConfigFiles(lane, dirs).map((file) => file.path)).toEqual([
      join(dirs.piAgent, 'mcp.json'),
      join(lane, '.pi', 'mcp.json'),
      join(dirs.piAgent, 'settings.json'),
      join(lane, '.pi', 'settings.json'),
    ])
  })
})

describe('lane config fingerprint', () => {
  it('changes when a server is toggled, and only then', async () => {
    const { dirs, lane, fingerprint } = await setup()
    const global = join(dirs.piAgent, 'mcp.json')
    await write(global, { mcpServers: { linear: { url: 'https://l' } } })
    const first = await fingerprint(lane)
    expect(await fingerprint(lane)).toBe(first)
    await write(global, { mcpServers: { linear: { url: 'https://l', enabled: false } } })
    const second = await fingerprint(lane)
    expect(second).not.toBe(first)
    await write(global, { mcpServers: { linear: { url: 'https://l' } } })
    expect(await fingerprint(lane)).toBe(first)
  })

  it('ignores reformatting and key order', async () => {
    const { dirs, lane, fingerprint } = await setup()
    const global = join(dirs.piAgent, 'mcp.json')
    await write(global, { mcpServers: { a: { url: 'u', exposure: 'direct' } } })
    const first = await fingerprint(lane)
    await write(global, '{"mcpServers":{"a":{"exposure":"direct","url":"u"}}}\n')
    expect(await fingerprint(lane)).toBe(first)
  })

  it('counts a file appearing, disappearing or becoming unparseable', async () => {
    const { lane, fingerprint } = await setup()
    const project = join(lane, '.pi', 'mcp.json')
    await mkdir(join(lane, '.pi'))
    const none = await fingerprint(lane)
    await write(project, { mcpServers: {} })
    const added = await fingerprint(lane)
    expect(added).not.toBe(none)
    await write(project, '{ not json')
    expect(await fingerprint(lane)).not.toBe(added)
    await rm(project)
    expect(await fingerprint(lane)).toBe(none)
  })

  it('follows the packages and extensions in settings.json, and nothing else there', async () => {
    const { dirs, lane, fingerprint } = await setup()
    const settings = join(dirs.piAgent, 'settings.json')
    // What an install with pi-mcp-adapter looks like, before the move.
    await write(settings, {
      packages: ['npm:pi-mcp-adapter'],
      extensions: ['-builtin:mcp'],
      defaultModel: 'a',
    })
    const before = await fingerprint(lane)
    // pi rewrites other settings on its own (a model switch); no reload for that.
    await write(settings, {
      packages: ['npm:pi-mcp-adapter'],
      extensions: ['-builtin:mcp'],
      defaultModel: 'b',
    })
    expect(await fingerprint(lane)).toBe(before)
    // The migration: built-in MCP back on, then the package gone. Each one counts.
    await write(settings, { packages: ['npm:pi-mcp-adapter'], extensions: [], defaultModel: 'b' })
    const builtinOn = await fingerprint(lane)
    expect(builtinOn).not.toBe(before)
    await write(settings, { packages: [], extensions: [], defaultModel: 'b' })
    expect(await fingerprint(lane)).not.toBe(builtinOn)
  })

  it('follows the project settings.json too', async () => {
    const { lane, fingerprint } = await setup()
    await mkdir(join(lane, '.pi'))
    const first = await fingerprint(lane)
    await write(join(lane, '.pi', 'settings.json'), { packages: ['npm:pi-mcp-adapter'] })
    expect(await fingerprint(lane)).not.toBe(first)
  })

  it('is per lane folder: another project’s config does not move it', async () => {
    const { lane, other, fingerprint } = await setup()
    const first = await fingerprint(lane)
    await mkdir(join(other, '.pi'))
    await write(join(other, '.pi', 'mcp.json'), { mcpServers: { x: { command: 'x' } } })
    expect(await fingerprint(lane)).toBe(first)
  })
})
