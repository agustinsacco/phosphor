import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  removeSettingsFixtures,
  settingsServiceFixture as fixture,
} from './__fixtures__/settings-service.fixture'
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({ runPrintMode: vi.fn() }))
afterEach(removeSettingsFixtures)

describe('Host Web access keys', () => {
  it('reads which keys are configured, never their values', async () => {
    const f = await fixture()
    await writeFile(
      join(f.agentDir, 'web-search.json'),
      JSON.stringify({ braveApiKey: 'BSA_PRIVATE', exaApiKey: '', searxngUrl: 'https://s.test' }),
      { mode: 0o600 },
    )
    const read = await f.read('resources')
    expect(read.resources?.webAccess).toEqual({
      configured: ['braveApiKey'],
      exists: true,
      malformed: false,
    })
    expect(JSON.stringify(read)).not.toContain('BSA_PRIVATE')
    expect(JSON.stringify(await f.settings.snapshot('resources'))).not.toContain('BSA_PRIVATE')
  })
  it('reports a missing file as not configured', async () => {
    const f = await fixture()
    expect((await f.read('resources')).resources?.webAccess).toEqual({
      configured: [],
      exists: false,
      malformed: false,
    })
  })
  it('sets and clears one key, keeping the rest, and saves 0600', async () => {
    const f = await fixture()
    const path = join(f.agentDir, 'web-search.json')
    await writeFile(path, JSON.stringify({ searxngUrl: 'https://s.test' }))
    await chmod(path, 0o644)
    const before = await f.read('resources')
    const set = await f.patch(
      'resources',
      { type: 'webAccess.key', key: 'tavilyApiKey', value: 'tvly-secret' },
      before.revision,
    )
    expect(set.ok).toBe(true)
    expect(JSON.stringify(set)).not.toContain('tvly-secret')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      searxngUrl: 'https://s.test',
      tavilyApiKey: 'tvly-secret',
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const after = await f.read('resources')
    expect(after.resources?.webAccess?.configured).toEqual(['tavilyApiKey'])
    const cleared = await f.patch(
      'resources',
      { type: 'webAccess.key', key: 'tavilyApiKey', value: null },
      after.revision,
    )
    expect(cleared.ok).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ searxngUrl: 'https://s.test' })
  })
  it('refuses a stale revision, a folder scope and a malformed file', async () => {
    const f = await fixture()
    const path = join(f.agentDir, 'web-search.json')
    const before = await f.read('resources')
    await writeFile(path, '{"kagiApiKey":"k"}', { mode: 0o600 })
    const change = { type: 'webAccess.key' as const, key: 'braveApiKey' as const, value: 'x' }
    expect((await f.patch('resources', change, before.revision)).ok).toBe(false)
    const current = await f.read('resources')
    expect((await f.patch('resources', change, current.revision, f.repository.id)).ok).toBe(false)
    await writeFile(path, '{ broken', { mode: 0o600 })
    const broken = await f.read('resources')
    expect(broken.resources?.webAccess).toEqual({ configured: [], exists: true, malformed: true })
    expect((await f.patch('resources', change, broken.revision)).ok).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('{ broken')
  })
})
