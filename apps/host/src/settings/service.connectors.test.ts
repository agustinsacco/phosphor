import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  removeSettingsFixtures,
  settingsServiceFixture as fixture,
} from './__fixtures__/settings-service.fixture'
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({ runPrintMode: vi.fn() }))
afterEach(removeSettingsFixtures)

describe('Host connectors read', () => {
  it('says which connectors sign in with OAuth, without sending their headers', async () => {
    const f = await fixture()
    await writeFile(
      join(f.agentDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          oauth: { url: 'https://oauth.example/mcp' },
          header: {
            url: 'https://header.example/mcp',
            headers: { authorization: 'Bearer HEADER_SECRET' },
          },
          provider: { url: 'https://provider.example/mcp', auth: { provider: 'github' } },
          local: { command: 'npx', args: ['tools'] },
        },
      }),
    )
    const read = await f.read('connectors')
    const byName = Object.fromEntries(
      (read.connectors?.servers ?? []).map((server) => [server.name, server]),
    )
    expect(byName.oauth?.oauth).toBe(true)
    expect(byName.header?.oauth).toBe(false)
    expect(byName.provider?.oauth).toBe(false)
    expect(byName.local).not.toHaveProperty('oauth')
    expect(JSON.stringify(read)).not.toContain('HEADER_SECRET')
  })

  it('marks a global connector the trusted folder overrides', async () => {
    const f = await fixture()
    await writeFile(
      join(f.agentDir, 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example/mcp' } } }),
    )
    await mkdir(join(f.repo, '.pi'), { recursive: true })
    await writeFile(
      join(f.repo, '.pi', 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { enabled: false } } }),
    )
    await writeFile(
      join(f.agentDir, 'trust.json'),
      JSON.stringify({ [await realpath(f.repo)]: true }),
    )
    const folder = await f.read('connectors', f.repository.id)
    expect(folder.connectors?.servers).toMatchObject([
      { name: 'docs', scope: 'global', enabled: false, overridden: true },
    ])
    const machine = await f.read('connectors')
    expect(machine.connectors?.servers[0]).not.toHaveProperty('overridden')
  })
})

it('patches only exposure under revision and transport checks, preserving private fields', async () => {
  const f = await fixture()
  const path = join(f.agentDir, 'mcp.json')
  const http = { url: 'https://example.com/mcp', headers: { authorization: 'fixture-header' } }
  const stdio = { command: 'fixture-command', env: { FIXTURE: 'secret' } }
  const original = JSON.stringify({ mcpServers: { http, stdio } })
  await writeFile(path, original)
  const before = await f.read('connectors')
  const expose = (name: string, transport: string, snapshot = before) =>
    f.settings.changeAgentConnector(
      snapshot,
      { type: 'mcp.expose', name, transport, exposure: 'direct' },
      false,
      () => true,
    )
  await expect(expose('stdio', 'https')).rejects.toThrow('pass --transport stdio')
  await expect(expose('http', 'stdio')).rejects.toThrow('HTTPS')
  expect(await readFile(path, 'utf8')).toBe(original)
  await expose('http', 'https')
  await expect(expose('stdio', 'stdio')).rejects.toThrow('Settings changed')
  await expose('stdio', 'stdio', await f.read('connectors'))
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    mcpServers: { http: { ...http, exposure: 'direct' }, stdio: { ...stdio, exposure: 'direct' } },
  })
})
