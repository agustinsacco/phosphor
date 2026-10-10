import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_MAX_BYTES, defaultConfigPath, loadHostConfig } from './load'

const minimal = { version: 1, pi: { executable: '/usr/local/bin/pi' }, repositories: ['/srv/a'] }
const uid = process.getuid!()
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-config-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A config file in its own folder, both with exactly the given modes. */
function write(content: string, mode = 0o600, folderMode = 0o700, folder = 'conf') {
  const parent = join(dir, folder)
  mkdirSync(parent, { recursive: true })
  chmodSync(parent, folderMode)
  const file = join(parent, 'config.json')
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

const messages = async (path: string, as: { uid: number | undefined } = { uid }) => {
  const result = await loadHostConfig(path, as.uid)
  return result.ok ? [] : result.errors.map((error) => error.message)
}

describe('config location', () => {
  it('is the XDG config folder on Linux and macOS alike, ignoring a relative XDG value', () => {
    expect(defaultConfigPath({}, '/home/me')).toBe('/home/me/.config/phosphor-host/config.json')
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/me')).toBe(
      '/xdg/phosphor-host/config.json',
    )
    expect(defaultConfigPath({ XDG_CONFIG_HOME: 'xdg' }, '/home/me')).toBe(
      '/home/me/.config/phosphor-host/config.json',
    )
  })
})

describe('loading the config', () => {
  it('loads an owner-only config', async () => {
    const file = write(JSON.stringify(minimal))
    expect(await loadHostConfig(file, uid)).toEqual({ ok: true, path: file, config: minimal })
    // Readable by others is fine: the config holds names and paths, never values.
    expect(await messages(write(JSON.stringify(minimal), 0o644, 0o755))).toEqual([])
  })

  it('refuses a file or folder others can write, naming the chmod to run', async () => {
    const file = write(JSON.stringify(minimal), 0o620)
    expect(await messages(file)).toEqual([`${file} is writable by others: run chmod go-w ${file}`])
    const folder = join(dir, 'open')
    expect(await messages(write(JSON.stringify(minimal), 0o600, 0o777, 'open'))).toEqual([
      `${folder} is writable by others: run chmod go-w ${folder}`,
    ])
  })

  it('refuses a config another user owns', async () => {
    const file = write(JSON.stringify(minimal))
    expect((await messages(file, { uid: uid + 1 })).join('\n')).toContain(
      `belongs to uid ${uid}, not to you`,
    )
  })

  it('checks the real file and its folder when the config is a symlink', async () => {
    const real = write(JSON.stringify(minimal), 0o600, 0o777, 'shared')
    const link = join(dir, 'conf/config.json')
    mkdirSync(join(dir, 'conf'), { mode: 0o700 })
    symlinkSync(real, link)
    expect(await messages(link)).toEqual([
      `${join(dir, 'shared')} is writable by others: run chmod go-w ${join(dir, 'shared')}`,
    ])
  })

  it('refuses a missing, oversized, unparsable or non-file config', async () => {
    expect(await messages(join(dir, 'missing.json'))).toEqual([
      `no config file at ${join(dir, 'missing.json')}`,
    ])
    expect(await messages(write(' '.repeat(CONFIG_MAX_BYTES + 1)))).toEqual([
      `${join(dir, 'conf/config.json')} is larger than 64 KiB`,
    ])
    expect(await messages(write('{'))).toEqual(['not valid JSON at position 1 (line 1 column 2)'])
    // V8 would quote the text around the bad token; a pasted value never comes back.
    expect(await messages(write('{"key": sk-ant-pasted-by-mistake}'))).toEqual(['not valid JSON'])
    expect(await messages(join(dir, 'conf'))).toEqual([`${join(dir, 'conf')} is not a file`])
  })

  it('reports schema problems at their pointers', async () => {
    const result = await loadHostConfig(write(JSON.stringify({ ...minimal, version: 2 })), uid)
    expect(result).toMatchObject({
      ok: false,
      errors: [{ pointer: '/version', message: 'must be 1' }],
    })
  })

  it('reports an unreadable config as a config problem, not a crash', async () => {
    const file = write(JSON.stringify(minimal), 0o200)
    expect((await messages(file))[0]).toMatch(/EACCES/)
  })

  it('refuses to run where files have no POSIX owner', async () => {
    expect(await messages(write(JSON.stringify(minimal)), { uid: undefined })).toEqual([
      'the Host runs on Linux and macOS',
    ])
  })
})
