import * as fs from 'node:fs'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HOST_PATH_BLOCK, installHostPath, removeHostPathBlocks } from './shell-path'

vi.mock('node:fs', { spy: true })
const homes: string[] = []
afterEach(() => {
  vi.resetAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
function home() {
  const value = mkdtempSync(join(tmpdir(), 'host-shell-'))
  homes.push(value)
  return value
}
function install(root: string, uid = process.getuid?.()) {
  const print = vi.fn()
  installHostPath({
    home: root,
    uid,
    platform: 'linux',
    env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
    print,
  })
  return print
}
it('appends one block through the opened fd and preserves existing content', () => {
  const root = home()
  const path = join(root, '.zshrc')
  writeFileSync(path, '# user config\n')
  expect(install(root)).toHaveBeenCalledWith(`Added Phosphor Host PATH to ${path}`)
  install(root)
  expect(readFileSync(path, 'utf8')).toBe(`# user config\n${HOST_PATH_BLOCK}`)
})
it('creates an absent rc without overwriting a file that appears before exclusive create', async () => {
  const root = home(),
    path = join(root, '.zshrc')
  const original = await vi.importActual<typeof fs>('node:fs')
  const flags: (string | number)[] = []
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === path) {
      flags.push(args[1])
      if (typeof args[1] === 'number' && args[1] & fs.constants.O_EXCL) {
        writeFileSync(path, '# appeared\n')
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      }
    }
    return original.openSync(...args)
  })
  install(root)
  expect(flags).toHaveLength(3)
  expect(readFileSync(path, 'utf8')).toBe(`# appeared\n${HOST_PATH_BLOCK}`)
})
it('refuses a symlink swapped in immediately before the append open', async () => {
  const root = home(),
    path = join(root, '.zshrc'),
    target = join(root, 'target')
  writeFileSync(path, '# rc\n')
  writeFileSync(target, '# untouched\n')
  const original = await vi.importActual<typeof fs>('node:fs')
  let swapped = false
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === path && !swapped) {
      swapped = true
      renameSync(path, join(root, 'old'))
      symlinkSync(target, path)
    }
    return original.openSync(...args)
  })
  expect(install(root)).toHaveBeenCalledWith(`Left unsafe shell startup file unchanged: ${path}`)
  expect(readFileSync(target, 'utf8')).toBe('# untouched\n')
})
it('refuses oversized, non-regular and other-owned rc files', () => {
  const root = home(),
    path = join(root, '.zshrc')
  writeFileSync(path, Buffer.alloc(1024 * 1024 + 1, 'x'))
  expect(install(root)).toHaveBeenCalledWith(`Left unsafe shell startup file unchanged: ${path}`)
  expect(statSync(path).size).toBe(1024 * 1024 + 1)
  writeFileSync(path, '# owned by someone else\n')
  expect(install(root, (process.getuid?.() ?? 0) + 1)).toHaveBeenCalledWith(
    `Left unsafe shell startup file unchanged: ${path}`,
  )
  expect(readFileSync(path, 'utf8')).toBe('# owned by someone else\n')
  rmSync(path)
  mkdirSync(path)
  expect(install(root)).toHaveBeenCalledWith(`Left unsafe shell startup file unchanged: ${path}`)
})
it('atomically removes every exact block and preserves bytes and permissions', () => {
  const root = home()
  const prefix = Buffer.from([0xff, 0x00, 0x41])
  for (const name of ['.zshrc', '.bashrc', '.profile']) {
    writeFileSync(
      join(root, name),
      Buffer.concat([prefix, Buffer.from(`${HOST_PATH_BLOCK}# user suffix\n${HOST_PATH_BLOCK}`)]),
      { mode: 0o640 },
    )
  }
  removeHostPathBlocks(root, process.getuid?.())
  for (const name of ['.zshrc', '.bashrc', '.profile']) {
    expect(readFileSync(join(root, name))).toEqual(
      Buffer.concat([prefix, Buffer.from('# user suffix\n')]),
    )
    expect(statSync(join(root, name)).mode & 0o777).toBe(0o640)
  }
  expect(readdirSync(root).sort()).toEqual(['.bashrc', '.profile', '.zshrc'])
})
it('keeps the rc group on removal, and leaves the rc untouched when it cannot', async () => {
  const root = home(),
    path = join(root, '.bashrc')
  const other = process.getgroups?.().find((gid) => gid !== statSync(root).gid)
  if (other === undefined) return
  writeFileSync(path, `# rc\n${HOST_PATH_BLOCK}`, { mode: 0o640 })
  fs.chownSync(path, process.getuid?.() ?? -1, other)
  removeHostPathBlocks(root, process.getuid?.())
  expect(readFileSync(path, 'utf8')).toBe('# rc\n')
  expect(statSync(path).gid).toBe(other)

  writeFileSync(path, `# rc\n${HOST_PATH_BLOCK}`)
  vi.spyOn(fs, 'fchownSync').mockImplementation(() => {
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
  })
  removeHostPathBlocks(root, process.getuid?.())
  expect(readFileSync(path, 'utf8')).toBe(`# rc\n${HOST_PATH_BLOCK}`)
  expect(readdirSync(root)).toEqual(['.bashrc'])
})
it('leaves the original byte-identical and removes staging after a partial write failure', async () => {
  const root = home(),
    path = join(root, '.zshrc')
  const before = Buffer.from(`# original\n${HOST_PATH_BLOCK}# suffix\n`)
  writeFileSync(path, before, { mode: 0o600 })
  const original = await vi.importActual<typeof fs>('node:fs')
  vi.spyOn(fs, 'writeSync')
    .mockImplementationOnce((fd, buffer) => {
      expect(original.fstatSync(fd).mode & 0o777).toBe(0o600)
      if (typeof buffer === 'string') throw new Error('unexpected string write')
      return original.writeSync(fd, buffer, 0, 16)
    })
    .mockImplementationOnce(() => {
      throw new Error('write failed')
    })
  expect(() => removeHostPathBlocks(root, process.getuid?.())).toThrow('write failed')
  expect(readFileSync(path)).toEqual(before)
  expect(readdirSync(root)).toEqual(['.zshrc'])
})
it.each(['symlink', 'file'])('does not publish removal over a swapped rc %s', async (kind) => {
  const root = home(),
    path = join(root, '.zshrc'),
    target = join(root, 'target')
  writeFileSync(path, HOST_PATH_BLOCK)
  writeFileSync(target, '# target\n')
  const original = await vi.importActual<typeof fs>('node:fs')
  vi.spyOn(fs, 'fsyncSync').mockImplementationOnce((fd) => {
    original.fsyncSync(fd)
    renameSync(path, join(root, 'old'))
    if (kind === 'symlink') symlinkSync(target, path)
    else writeFileSync(path, '# replacement\n')
  })
  removeHostPathBlocks(root, process.getuid?.())
  expect(fs.lstatSync(path).isSymbolicLink()).toBe(kind === 'symlink')
  expect(readFileSync(path, 'utf8')).toBe(kind === 'symlink' ? '# target\n' : '# replacement\n')
  expect(readFileSync(target, 'utf8')).toBe('# target\n')
  expect(readFileSync(join(root, 'old'), 'utf8')).toBe(HOST_PATH_BLOCK)
  expect(readdirSync(root).sort()).toEqual(['.zshrc', 'old', 'target'])
})
it('never follows symlinks or changes non-regular, foreign-owned or altered blocks', () => {
  const root = home()
  const target = join(root, 'target')
  writeFileSync(target, HOST_PATH_BLOCK)
  symlinkSync(target, join(root, '.zshrc'))
  mkdirSync(join(root, '.bashrc'))
  writeFileSync(join(root, '.profile'), HOST_PATH_BLOCK)
  removeHostPathBlocks(root, (process.getuid?.() ?? 0) + 1)
  expect(readFileSync(join(root, '.profile'), 'utf8')).toBe(HOST_PATH_BLOCK)
  writeFileSync(join(root, '.profile'), HOST_PATH_BLOCK.replace('export PATH=', 'export CUSTOM='))
  removeHostPathBlocks(root, process.getuid?.())
  expect(readFileSync(target, 'utf8')).toBe(HOST_PATH_BLOCK)
  expect(readFileSync(join(root, '.profile'), 'utf8')).toContain('export CUSTOM=')
})

it('keeps the appended block within the rc size bound, at the limit and one byte over', () => {
  const root = home(),
    path = join(root, '.zshrc')
  const limit = 1024 * 1024 - Buffer.byteLength(HOST_PATH_BLOCK)
  writeFileSync(path, 'x'.repeat(limit))
  expect(install(root)).toHaveBeenCalledWith(`Added Phosphor Host PATH to ${path}`)
  expect(statSync(path).size).toBe(1024 * 1024)
  removeHostPathBlocks(root, process.getuid?.())
  expect(statSync(path).size).toBe(limit)
  writeFileSync(path, 'x'.repeat(limit + 1))
  expect(install(root)).toHaveBeenCalledWith(`Left unsafe shell startup file unchanged: ${path}`)
  expect(statSync(path).size).toBe(limit + 1)
})
