import { describe, expect, it } from 'vitest'
import { FILE_BYTES_LIMITS, parseFileBytes, parseFileBytesParams } from './host-protocol-file-bytes'

const laneId = '7f1c2a4e-9b3d-4c5e-8f6a-1b2c3d4e5f60'
const version = 'a'.repeat(32)
const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64')

describe('parseFileBytesParams', () => {
  it('takes a lane or a repository, a path and a bounded window', () => {
    expect(parseFileBytesParams({ laneId, path: 'a/b.mp4', offset: 0, length: 10 })).toEqual({
      laneId,
      path: 'a/b.mp4',
      offset: 0,
      length: 10,
    })
    expect(
      parseFileBytesParams({ repositoryId: '1234567890abcdef', path: 'x', offset: 5, length: 0 }),
    ).toEqual({ repositoryId: '1234567890abcdef', path: 'x', offset: 5, length: 0 })
  })

  it('refuses bad paths, windows and extra keys', () => {
    const ok = { laneId, path: 'x', offset: 0, length: 1 }
    for (const bad of [
      { ...ok, path: '../x' },
      { ...ok, path: '.git/config' },
      { ...ok, offset: -1 },
      { ...ok, offset: 1.5 },
      { ...ok, offset: FILE_BYTES_LIMITS.fileBytes + 1 },
      { ...ok, length: FILE_BYTES_LIMITS.chunkBytes + 1 },
      { ...ok, extra: true },
      { laneId, offset: 0, length: 1 },
      { ...ok, laneId: 'nope' },
      null,
      [],
    ])
      expect(parseFileBytesParams(bad)).toBeNull()
  })
})

describe('parseFileBytes', () => {
  it('accepts exactly the bytes asked for, or the file end', () => {
    expect(parseFileBytes({ size: 10, version, data: b64(4) }, { offset: 0, length: 4 })).toEqual({
      size: 10,
      version,
      data: b64(4),
    })
    expect(parseFileBytes({ size: 10, version, data: b64(2) }, { offset: 8, length: 4 })).toEqual({
      size: 10,
      version,
      data: b64(2),
    })
    expect(parseFileBytes({ size: 0, version, data: '' }, { offset: 0, length: 4 })).not.toBeNull()
  })

  it('refuses short, long, malformed and oversized answers', () => {
    const at = { offset: 0, length: 4 }
    expect(parseFileBytes({ size: 10, version, data: b64(3) }, at)).toBeNull()
    expect(parseFileBytes({ size: 10, version, data: b64(5) }, at)).toBeNull()
    expect(parseFileBytes({ size: 10, version, data: 'not base64!' }, at)).toBeNull()
    expect(parseFileBytes({ size: 10, version: 'x', data: b64(4) }, at)).toBeNull()
    expect(parseFileBytes({ size: 2, version, data: b64(4) }, { offset: 3, length: 4 })).toBeNull()
    expect(
      parseFileBytes({ size: FILE_BYTES_LIMITS.fileBytes + 1, version, data: b64(4) }, at),
    ).toBeNull()
    expect(parseFileBytes({ size: 10, version, data: b64(4), more: 1 }, at)).toBeNull()
  })
})
