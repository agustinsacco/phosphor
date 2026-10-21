import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSettingsFile, settingsFile, withSettingsFileLock } from './files'
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'host-settings-'))
  dirs.push(dir)
  return { dir, path: join(dir, 'settings.json') }
}
describe('private revision-checked settings files', () => {
  it('edits owner-controlled pi config created with a group-writable umask', async () => {
    const { dir, path } = await fixture()
    await chmod(dir, 0o775)
    await writeFile(path, '{"defaultModel":"before"}', { mode: 0o664 })
    await chmod(path, 0o664)
    const before = settingsFile(path)
    await saveSettingsFile(path, { ...before.raw, defaultModel: 'after' }, before.revision, () => true)
    expect(settingsFile(path).raw.defaultModel).toBe('after')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it('creates private files and preserves unknown settings', async () => {
    const { path } = await fixture()
    await writeFile(path, JSON.stringify({ packages: ['npm:user'], unrelated: { keep: true } }), {
      mode: 0o600,
    })
    const previous = settingsFile(path)
    await withSettingsFileLock(path, () =>
      saveSettingsFile(
        path,
        { ...previous.raw, defaultModel: 'new' },
        previous.revision,
        () => true,
      ),
    )
    expect(settingsFile(path).raw).toEqual({
      packages: ['npm:user'],
      unrelated: { keep: true },
      defaultModel: 'new',
    })
    expect(settingsFile(path).revision).not.toBe(previous.revision)
  })
  it('refuses stale and revoked saves without leaving temporary files', async () => {
    const { dir, path } = await fixture()
    const previous = settingsFile(path)
    await writeFile(path, '{"other":true}', { mode: 0o600 })
    await expect(
      saveSettingsFile(path, { changed: true }, previous.revision, () => true),
    ).rejects.toThrow('Reload')
    await expect(
      saveSettingsFile(path, { changed: true }, settingsFile(path).revision, () => false),
    ).rejects.toThrow('revoked')
    expect(settingsFile(path).raw).toEqual({ other: true })
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
      await saveSettingsFile(path, { ok: true }, settingsFile(path).revision, () => true)
    })
    await expect(first).rejects.toThrow('failed')
    await second
    expect(order).toEqual([1, 2])
    expect(settingsFile(path).raw).toEqual({ ok: true })
  })
  it.each(['not json', '[]', 'null'])('never replaces malformed settings: %s', async (text) => {
    const { path } = await fixture()
    await writeFile(path, text, { mode: 0o600 })
    expect(() => settingsFile(path)).toThrow()
    expect(await readFile(path, 'utf8')).toBe(text)
  })
  it('refuses symlinks, unsafe permissions, oversized files and unsafe parent directories', async () => {
    const { path, dir } = await fixture()
    const target = join(dir, 'credentials.json')
    await writeFile(target, '{"secret":"private"}', { mode: 0o600 })
    await symlink(target, path)
    expect(() => settingsFile(path)).toThrow()
    await rm(path)
    await writeFile(path, '{}', { mode: 0o666 })
    await chmod(path, 0o666)
    expect(() => settingsFile(path)).toThrow()
    await chmod(path, 0o600)
    await writeFile(path, ' '.repeat(65537))
    expect(() => settingsFile(path)).toThrow()
    await writeFile(path, '{}')
    const previous = settingsFile(path)
    await chmod(dir, 0o777)
    await expect(saveSettingsFile(path, {}, previous.revision, () => true)).rejects.toThrow(
      'directory',
    )
    await chmod(dir, 0o700)
    expect(await readFile(target, 'utf8')).toContain('private')
  })
})
