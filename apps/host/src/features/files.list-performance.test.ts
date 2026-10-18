import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import { listedPaths } from './files'

vi.mock('node:fs/promises', { spy: true })
vi.mock('@phosphor/session-runtime/git/git-exec', () => ({ git: vi.fn() }))
let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'list-validation-')))
  vi.mocked(git).mockReset()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
// The full files public contract remains frozen in files.contract.characterization.test.ts (HA-30).
describe('listedPaths security and ordering contract', () => {
  it('returns a large fixed tree in deduplicated git order with every component checked', async () => {
    await fs.mkdir(join(root, 'parent'))
    const files = Array.from({ length: 256 }, (_, i) => `parent/file-${255 - i}`)
    await Promise.all(files.map((file) => fs.writeFile(join(root, file), 'text')))
    vi.mocked(git).mockResolvedValue([...files, files[0]].join('\0'))
    vi.mocked(fs.realpath).mockClear()
    expect(await listedPaths(root)).toEqual(files)
    expect(fs.realpath).toHaveBeenCalledTimes(files.length * 2)
  })
  it('does not cache authorization across calls after a parent directory swap', async () => {
    await fs.mkdir(join(root, 'parent'))
    await fs.writeFile(join(root, 'parent/file'), 'text')
    vi.mocked(git).mockResolvedValue('parent/file\0')
    expect(await listedPaths(root)).toEqual(['parent/file'])
    await fs.rename(join(root, 'parent'), join(root, 'old'))
    await fs.symlink(join(root, '..'), join(root, 'parent'))
    await expect(listedPaths(root)).rejects.toThrow('bad-request')
  })
  it('rechecks a leaf swapped to a metadata alias on the next call', async () => {
    await fs.mkdir(join(root, '.git'))
    await fs.writeFile(join(root, '.git/config'), 'secret')
    await fs.writeFile(join(root, 'leaf'), 'text')
    vi.mocked(git).mockResolvedValue('leaf\0')
    expect(await listedPaths(root)).toEqual(['leaf'])
    await fs.unlink(join(root, 'leaf'))
    await fs.symlink(join(root, '.git/config'), join(root, 'leaf'))
    await expect(listedPaths(root)).rejects.toThrow('bad-request')
  })
  it('rejects over 20k unique entries before any per-file syscall', async () => {
    vi.mocked(git).mockResolvedValue(
      Array.from({ length: FILE_LIMITS.entries + 1 }, (_, i) => `f${i}`).join('\0'),
    )
    vi.mocked(fs.realpath).mockClear()
    await expect(listedPaths(root)).rejects.toThrow('too-large')
    expect(fs.realpath).not.toHaveBeenCalled()
  })
})
