import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { setMcpExposure } from './mcp-config'

let dir: string
const dirs = () => ({ home: dir, piAgent: dir, xdgConfig: dir })
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})
it('edits only visibility fields and preserves credentials and unknown keys', async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-exposure-'))
  const config = {
    url: 'https://api.test/mcp',
    headers: { Authorization: '!keychain' },
    timeout: 99,
    custom: true,
  }
  const file = join(dir, 'mcp.json')
  await writeFile(file, JSON.stringify({ custom: 'preserve', mcpServers: { api: config } }))
  await setMcpExposure('global', undefined, 'api', 'deferred', { 'get_*': 'direct' }, dirs())
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
    custom: 'preserve',
    mcpServers: {
      api: { ...config, exposure: 'deferred', toolExposure: { 'get_*': 'direct' } },
    },
  })
})
it('keeps project overrides partial and rejects invalid changes', async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-exposure-'))
  await mkdir(join(dir, '.pi'))
  const file = join(dir, '.pi/mcp.json')
  await writeFile(file, JSON.stringify({ mcpServers: { api: { enabled: true } } }))
  await setMcpExposure('project', dir, 'api', 'codemode', { search: 'direct' }, dirs())
  const expected = {
    mcpServers: {
      api: { enabled: true, exposure: 'codemode', toolExposure: { search: 'direct' } },
    },
  }
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expected)
  await expect(
    setMcpExposure('project', dir, 'api', 'codemode', { search: 'bad' } as never, dirs()),
  ).rejects.toThrow('Invalid')
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expected)
})
