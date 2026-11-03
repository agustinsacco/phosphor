import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
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
  // P35: the revision once hashed the package list while the commit check hashed files.
  it("accepts a resources read's revision, with a package listed, at the next resources commit", async () => {
    const f = await fixture()
    await writeFile(join(f.agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:keep'] }), {
      mode: 0o600,
    })
    const before = await f.read('resources')
    expect(before.resources?.packages.map((package_) => package_.spec)).toEqual(['npm:keep'])
    const change = { type: 'webAccess.key' as const, key: 'braveApiKey' as const, value: 'x' }
    expect((await f.patch('resources', change, before.revision)).ok).toBe(true)
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
  // A dotfile-managed link is common; the Host will not edit it, but Resources still loads.
  it.each([
    ['a link', (path: string) => symlink(join(path, '..', 'dotfile.json'), path)],
    ['unreadable', (path: string) => writeFile(path, '{}', { mode: 0o000 })],
    ['a directory', (path: string) => mkdir(path)],
  ])(
    'reads a web-search.json that is %s as malformed, never failing Resources',
    async (_, make) => {
      const f = await fixture()
      const path = join(f.agentDir, 'web-search.json')
      await writeFile(join(f.agentDir, 'dotfile.json'), '{"braveApiKey":"BSA_PRIVATE"}', {
        mode: 0o600,
      })
      await make(path)
      const reading = f.read('resources')
      const malformed = { configured: [], exists: true, malformed: true }
      await expect(reading).resolves.toMatchObject({ resources: { webAccess: malformed } })
      const read = await reading
      const change = { type: 'webAccess.key' as const, key: 'braveApiKey' as const, value: 'x' }
      expect((await f.patch('resources', change, read.revision)).ok).toBe(false)
      expect(JSON.stringify(read)).not.toContain('BSA_PRIVATE')
    },
  )
})
