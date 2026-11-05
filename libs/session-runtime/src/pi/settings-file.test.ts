import { afterEach, describe, expect, it } from 'vitest'
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_FILE_POLICY as DESKTOP,
  HOST_FILE_POLICY as HOST,
  privateFilePolicy,
  saveSettingsFile,
  SettingsFailure,
  settingsFile,
  withSettingsFileLock,
  writeSettingsText,
} from './settings-file'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'host-settings-'))
  dirs.push(dir)
  return { dir, path: join(dir, 'settings.json') }
}
const allowed = () => true
describe('private revision-checked settings files (Host policy)', () => {
  it('edits owner-controlled pi config created with a group-writable umask', async () => {
    const { dir, path } = await fixture()
    await chmod(dir, 0o775)
    await writeFile(path, '{"defaultModel":"before"}', { mode: 0o664 })
    await chmod(path, 0o664)
    const before = settingsFile(path, HOST)
    await saveSettingsFile(
      path,
      { ...before.raw, defaultModel: 'after' },
      before.revision,
      allowed,
      HOST,
    )
    expect(settingsFile(path, HOST).raw.defaultModel).toBe('after')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it('creates private files and preserves unknown settings', async () => {
    const { path } = await fixture()
    await writeFile(path, JSON.stringify({ packages: ['npm:user'], unrelated: { keep: true } }), {
      mode: 0o600,
    })
    const previous = settingsFile(path, HOST)
    await withSettingsFileLock(path, () =>
      saveSettingsFile(
        path,
        { ...previous.raw, defaultModel: 'new' },
        previous.revision,
        allowed,
        HOST,
      ),
    )
    expect(settingsFile(path, HOST).raw).toEqual({
      packages: ['npm:user'],
      unrelated: { keep: true },
      defaultModel: 'new',
    })
    expect(settingsFile(path, HOST).revision).not.toBe(previous.revision)
  })
  it('refuses stale and revoked saves without leaving temporary files', async () => {
    const { dir, path } = await fixture()
    const previous = settingsFile(path, HOST)
    await writeFile(path, '{"other":true}', { mode: 0o600 })
    await expect(
      saveSettingsFile(path, { changed: true }, previous.revision, allowed, HOST),
    ).rejects.toThrow('Reload')
    await expect(
      saveSettingsFile(
        path,
        { changed: true },
        settingsFile(path, HOST).revision,
        () => false,
        HOST,
      ),
    ).rejects.toThrow('revoked')
    expect(settingsFile(path, HOST).raw).toEqual({ other: true })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })
  it('serializes writers without poisoning the lock after a failed save', async () => {
    const { path } = await fixture()
    const order: number[] = []
    const first = withSettingsFileLock(path, async () => {
      order.push(1)
      throw new Error('failed')
    })
    const second = withSettingsFileLock(path, async () => {
      order.push(2)
      await saveSettingsFile(path, { ok: true }, settingsFile(path, HOST).revision, allowed, HOST)
    })
    await expect(first).rejects.toThrow('failed')
    await second
    expect(order).toEqual([1, 2])
    expect(settingsFile(path, HOST).raw).toEqual({ ok: true })
  })
  it.each(['not json', '[]', 'null'])('never replaces malformed settings: %s', async (text) => {
    const { path } = await fixture()
    await writeFile(path, text, { mode: 0o600 })
    expect(() => settingsFile(path, HOST)).toThrow(expect.objectContaining({ malformed: true }))
    expect(await readFile(path, 'utf8')).toBe(text)
  })
  it('reads a blank file as empty settings', async () => {
    const { path } = await fixture()
    await writeFile(path, '  \n', { mode: 0o600 })
    expect(settingsFile(path, HOST).raw).toEqual({})
  })
  it('refuses symlinks, unsafe permissions, oversized files and unsafe parent directories', async () => {
    const { path, dir } = await fixture()
    const target = join(dir, 'credentials.json')
    await writeFile(target, '{"secret":"private"}', { mode: 0o600 })
    await symlink(target, path)
    expect(() => settingsFile(path, HOST)).toThrow(SettingsFailure)
    expect(settingsFile(path, DESKTOP).raw).toEqual({ secret: 'private' })
    await rm(path)
    await writeFile(path, '{}', { mode: 0o666 })
    await chmod(path, 0o666)
    expect(() => settingsFile(path, HOST)).toThrow()
    await chmod(path, 0o600)
    await writeFile(path, ' '.repeat(65537))
    expect(() => settingsFile(path, HOST)).toThrow()
    await writeFile(path, '{}')
    const previous = settingsFile(path, HOST)
    await chmod(dir, 0o777)
    await expect(saveSettingsFile(path, {}, previous.revision, allowed, HOST)).rejects.toThrow(
      'directory',
    )
    await chmod(dir, 0o700)
    expect(await readFile(target, 'utf8')).toContain('private')
  })
})

describe('dotfile settings files (Desktop policy)', () => {
  it('saves through a link, keeping the link and the file mode', async () => {
    const { dir, path } = await fixture()
    const target = join(dir, 'dotfiles-settings.json')
    await writeFile(target, '{"theme":"dark"}')
    await chmod(target, 0o664)
    await symlink(target, path)
    const before = settingsFile(path, DESKTOP)
    await saveSettingsFile(path, { ...before.raw, model: 'x' }, before.revision, allowed, DESKTOP)
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect((await stat(target)).mode & 0o777).toBe(0o664)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ theme: 'dark', model: 'x' })
  })
  it('creates a missing file 0644 and refuses a stale save', async () => {
    const { path } = await fixture()
    const before = settingsFile(path, DESKTOP)
    await saveSettingsFile(path, { a: 1 }, before.revision, allowed, DESKTOP)
    expect((await stat(path)).mode & 0o777).toBe(0o644)
    await expect(
      saveSettingsFile(path, { a: 2 }, before.revision, allowed, DESKTOP),
    ).rejects.toThrow('Reload')
  })
  it('saves a credential file 0600, chmodding one that exists, through its link', async () => {
    const { dir, path } = await fixture()
    const target = join(dir, 'dotfiles-web.json')
    await writeFile(target, '{}')
    await chmod(target, 0o644)
    await symlink(target, path)
    const policy = privateFilePolicy(DESKTOP)
    const { revision } = settingsFile(path, policy)
    await writeSettingsText(path, '{ "key": "value" }\n', revision, allowed, policy)
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect(await readFile(target, 'utf8')).toBe('{ "key": "value" }\n')
  })
})
