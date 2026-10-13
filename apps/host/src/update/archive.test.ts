import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it } from 'vitest'
import { decompressRelease, extractRelease as extractTar } from './archive'
const extractRelease = (bytes: Buffer, folder: string, maxBytes?: number) =>
  extractTar(decompressRelease(bytes, maxBytes), folder, maxBytes)
import { fixture, tar } from './__fixtures__/release'
const fixtures: ReturnType<typeof fixture>[] = []
function folder() {
  const f = fixture()
  fixtures.push(f)
  const path = join(f.home, 'stage')
  mkdirSync(path)
  return path
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})
it('accepts the exact decompressed budget, fixed executable modes and installer paths', () => {
  const path = folder(),
    bytes = tar([
      { name: 'VERSION' },
      { name: 'bin/phosphor' },
      { name: 'node/bin/node' },
      { name: 'lib/a.b/c-d_e' },
    ])
  const mask = process.umask(0o077)
  try {
    extractRelease(gzipSync(bytes), path, bytes.length)
  } finally {
    process.umask(mask)
  }
  expect(statSync(join(path, 'lib/a.b')).mode & 0o777).toBe(0o755)
  expect(statSync(join(path, 'lib')).mode & 0o777).toBe(0o755)
  expect(readFileSync(join(path, 'VERSION'), 'utf8')).toBe('test')
  expect(statSync(join(path, 'VERSION')).mode & 0o777).toBe(0o644)
  expect(statSync(join(path, 'bin/phosphor')).mode & 0o777).toBe(0o755)
  expect(statSync(join(path, 'node/bin/node')).mode & 0o777).toBe(0o755)
})
it('refuses gzip expansion one byte over budget before extraction', () => {
  const path = folder(),
    bytes = tar([{ name: 'lib/bomb', text: 'x'.repeat(8192) }])
  expect(() => extractRelease(gzipSync(bytes), path, bytes.length - 1)).toThrow()
  expect(readdirSync(path)).toEqual([])
})
it('refuses a truncated declared payload before writing anything', () => {
  const path = folder()
  expect(() => extractTar(tar([{ name: 'lib/a', size: 999999 }]), path)).toThrow()
  expect(readdirSync(path)).toEqual([])
})
it('checks each declared file size against the remaining expanded budget before writing', () => {
  const path = folder()
  expect(() => extractTar(tar([{ name: 'lib/a', text: 'x'.repeat(512) }]), path, 700)).toThrow()
  expect(readdirSync(path)).toEqual([])
})
it('accepts 4096 entries, refuses 4097, duplicates and file/parent collisions', () => {
  const entries = Array.from({ length: 4096 }, (_, i) => ({ name: `lib/file${i}`, text: '' }))
  expect(() => extractRelease(gzipSync(tar(entries)), folder())).not.toThrow()
  expect(() =>
    extractRelease(gzipSync(tar([...entries, { name: 'lib/extra' }])), folder()),
  ).toThrow()
  for (const names of [
    ['lib/a', 'lib/a'],
    ['lib/a', 'lib/a/b'],
  ])
    expect(() => extractRelease(gzipSync(tar(names.map((name) => ({ name })))), folder())).toThrow()
})
it('refuses bad checksums, truncated data, trailing garbage, missing terminators, empty archives and unsafe fields', () => {
  const bytes = tar([{ name: 'lib/a' }])
  const checksum = Buffer.from(bytes)
  checksum[108] = 49
  const magic = Buffer.from(bytes)
  magic[257] = 88
  const prefix = Buffer.from(bytes)
  prefix[345] = 88
  const link = Buffer.from(bytes)
  link[157] = 88
  const high = Buffer.from(bytes)
  high[4] = 225
  const hidden = Buffer.from(bytes)
  hidden[12] = 88
  for (const bad of [
    checksum,
    magic,
    prefix,
    link,
    hidden,
    high,
    bytes.subarray(0, 513),
    bytes.subarray(0, -512),
    bytes.subarray(0, -1024),
    tar([{ name: 'lib/a' }], Buffer.concat([Buffer.alloc(512), Buffer.alloc(512, 1)])),
    Buffer.concat([bytes, Buffer.alloc(1)]),
    tar([{ name: 'lib/a' }], Buffer.alloc(1024, 1)),
    Buffer.alloc(1024),
    tar([{ name: 'lib/a', size: 999999 }]),
  ])
    expect(() => extractRelease(gzipSync(bad), folder())).toThrow()
})
it.each(['lib//a', 'node/other', 'lib/..', 'lib/.', 'lib/../a', '/lib/a', '../a'])(
  'refuses non-installer path %s',
  (name) => {
    expect(() => extractRelease(gzipSync(tar([{ name }])), folder())).toThrow()
  },
)
