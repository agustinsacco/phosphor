import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkedPath, FileFailure, readResult } from '../files'
import { guardedRead } from './read'

vi.mock('node:fs/promises', { spy: true })
const ports = {
  checkedPath,
  readResult,
  error: (code: ConstructorParameters<typeof FileFailure>[0]) => new FileFailure(code),
}
let root: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'guarded-read-')))
  await fs.writeFile(join(root, 'file'), 'hello')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
async function interceptOpen(visit: (handle: fs.FileHandle) => Promise<void>) {
  const { open } = await vi.importActual<typeof fs>('node:fs/promises')
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    await visit(handle)
    return handle
  })
}
describe('guardedRead', () => {
  it('accumulates short reads and computes the revision from the returned bytes', async () => {
    await interceptOpen(async (handle) => {
      const stat = handle.stat.bind(handle)
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        const result = await stat()
        result.size += 3
        return result
      })
    })
    const recheck = vi.fn()
    expect(await guardedRead(root, 'file', recheck, ports)).toEqual({
      ok: true,
      data: {
        binary: false,
        size: 8,
        content: 'hello',
        revision: createHash('sha256').update('hello').digest('hex'),
      },
    })
    expect(recheck).toHaveBeenCalledOnce()
  })
  it('keeps reading after a partial read until the file ends', async () => {
    const reads: number[] = []
    await interceptOpen(async (handle) => {
      const read = handle.read.bind(handle) as (
        ...args: unknown[]
      ) => Promise<fs.FileReadResult<Buffer>>
      vi.spyOn(handle, 'read').mockImplementation((async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const result = await read(buffer, offset, Math.min(length, 2), position)
        reads.push(result.bytesRead)
        return result
      }) as typeof handle.read)
    })
    const result = await guardedRead(root, 'file', vi.fn(), ports)
    expect(result).toMatchObject({ ok: true, data: { content: 'hello', size: 5 } })
    expect(reads).toEqual([2, 2, 1, 0])
  })
  it.each(['dev', 'ino', 'type'] as const)(
    'closes after rejecting descriptor %s',
    async (field) => {
      const close = vi.fn()
      await interceptOpen(async (handle) => {
        const stat = handle.stat.bind(handle)
        const originalClose = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          close()
          await originalClose()
        })
        vi.spyOn(handle, 'stat').mockImplementation(async () => {
          const result = await stat()
          if (field === 'type') result.isFile = () => false
          else result[field] += 1
          return result
        })
      })
      await expect(guardedRead(root, 'file', vi.fn(), ports)).rejects.toThrow('bad-request')
      expect(close).toHaveBeenCalledOnce()
    },
  )
  it('rechecks path identity after opening and closes on path replacement', async () => {
    const close = vi.fn()
    await interceptOpen(async (handle) => {
      const originalClose = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        close()
        await originalClose()
      })
      await fs.rename(join(root, 'file'), join(root, 'old'))
      await fs.writeFile(join(root, 'file'), 'new')
    })
    await expect(guardedRead(root, 'file', vi.fn(), ports)).rejects.toThrow('bad-request')
    expect(close).toHaveBeenCalledOnce()
  })
  it('propagates close errors even after a successful read', async () => {
    await interceptOpen(async (handle) => {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        throw new Error('close failed')
      })
    })
    await expect(guardedRead(root, 'file', vi.fn(), ports)).rejects.toThrow('close failed')
  })
  it('closes when the authorization recheck fails', async () => {
    const close = vi.fn()
    await interceptOpen(async (handle) => {
      const originalClose = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        close()
        await originalClose()
      })
    })
    await expect(
      guardedRead(
        root,
        'file',
        () => {
          throw new Error('removed')
        },
        ports,
      ),
    ).rejects.toThrow('removed')
    expect(close).toHaveBeenCalledOnce()
  })
})
