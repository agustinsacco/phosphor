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

async function delayedValidation(files: string[], serial = false) {
  let active = 0,
    peak = 0,
    calls = 0,
    ticks = 0,
    done = false
  const pending: (() => void)[] = []
  vi.spyOn(fs, 'realpath').mockImplementation(async (path) => {
    if (typeof path !== 'string') throw new Error('Expected a string path')
    active++
    peak = Math.max(peak, active)
    calls++
    await new Promise<void>((resolve) => pending.push(resolve))
    active--
    return path
  })
  vi.mocked(git).mockResolvedValue(files.join('\0'))
  const run = serial
    ? (async () => {
        const { checkedPath } = await import('./files')
        for (const file of files) await checkedPath(root, file, true)
        return files
      })()
    : listedPaths(root)
  void run.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  while (!done) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (pending.length) {
      ticks++
      for (const resolve of pending.splice(0)) resolve()
    }
  }
  return { files: await run, peak, calls, ticks }
}

describe('listedPaths bounded concurrency regression', () => {
  it('validates eight files concurrently with lower deterministic latency but unchanged syscall count', async () => {
    const files = Array.from({ length: 32 }, (_, i) => `dir/file-${i}`)
    const batched = await delayedValidation(files)
    const serial = await delayedValidation(files, true)
    expect(batched.files).toEqual(files)
    expect(batched.peak).toBe(8)
    expect(serial.peak).toBe(1)
    expect(batched.calls).toBe(files.length * 2)
    expect(batched.calls).toBe(serial.calls)
    expect(batched.ticks).toBe(8)
    expect(serial.ticks).toBe(64)
  })
  it.each(['parent', 'leaf'] as const)(
    'refuses a %s swapped during per-component validation',
    async (swap) => {
      await fs.mkdir(join(root, 'dir'))
      await fs.mkdir(join(root, '.git'))
      await fs.writeFile(join(root, '.git/config'), 'secret')
      await fs.writeFile(join(root, 'dir/file'), 'text')
      const outside = `${root}-outside`
      await fs.mkdir(outside)
      await fs.writeFile(join(outside, 'file'), 'secret')
      const { realpath } = await vi.importActual<typeof fs>('node:fs/promises')
      vi.spyOn(fs, 'realpath').mockImplementation(async (path) => {
        if (path === join(root, 'dir/file')) {
          if (swap === 'parent') {
            await fs.rename(join(root, 'dir'), join(root, 'old'))
            await fs.symlink(outside, join(root, 'dir'))
          } else {
            await fs.unlink(join(root, 'dir/file'))
            await fs.symlink(join(root, '.git/config'), join(root, 'dir/file'))
          }
        }
        return realpath(path)
      })
      vi.mocked(git).mockResolvedValue('dir/file\0')
      try {
        await expect(listedPaths(root)).rejects.toThrow('bad-request')
      } finally {
        await fs.rm(outside, { recursive: true, force: true })
      }
    },
  )
})

afterEach(async () => {
  vi.mocked(fs.realpath).mockImplementation(
    (await vi.importActual<typeof fs>('node:fs/promises')).realpath,
  )
})
