import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { crc32 } from '@phosphor/shared/zip-store'
import { invalidZipEntryName, readZipEntries, writeZipStore } from './zip'

describe('writeZipStore → readZipEntries', () => {
  it('round-trips a bundle', () => {
    const zip = writeZipStore([
      { path: 'demo/SKILL.md', data: Buffer.from('---\nname: demo\n---\nbody') },
      { path: 'demo/references/notes.md', data: Buffer.from('notes') },
    ])
    const entries = readZipEntries(zip)
    expect(entries.map((entry) => entry.path)).toEqual([
      'demo/SKILL.md',
      'demo/references/notes.md',
    ])
    expect(entries[1]!.data.toString()).toBe('notes')
  })
})

describe('entry-name guards', () => {
  it.each([
    ['../evil', 'path traversal'],
    ['a/../../evil', 'path traversal'],
    ['/abs', 'absolute'],
    ['a\\b', 'backslash'],
    ['', 'empty'],
  ])('refuses %s', (name, reason) => {
    expect(invalidZipEntryName(name)).toContain(reason)
  })

  it('refuses a whole archive containing one traversal entry', () => {
    const zip = writeZipStore([
      { path: 'ok.md', data: Buffer.from('fine') },
      { path: '../escape.md', data: Buffer.from('evil') },
    ])
    expect(() => readZipEntries(zip)).toThrow(/traversal/)
  })
})

describe('symlink refusal', () => {
  it('rejects an entry whose unix mode marks a symlink', () => {
    const zip = writeZipStore([{ path: 'link', data: Buffer.from('/etc/passwd') }])
    // Flip the central-directory external attributes to S_IFLNK (0xa000 << 16).
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(0xa1ff0000 >>> 0, central + 38)
    expect(() => readZipEntries(zip)).toThrow(/symlink/)
  })
})

describe('size caps', () => {
  it('rejects a declared size mismatch (zip-bomb shape)', () => {
    const data = Buffer.from('x'.repeat(64))
    const zip = writeZipStore([{ path: 'a.md', data }])
    // Lie about the uncompressed size in both headers.
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    zip.writeUInt32LE(7, central + 24)
    zip.writeUInt32LE(7, 22)
    expect(() => readZipEntries(zip)).toThrow(/size mismatch|entry too large/)
  })
})

describe('deflate support', () => {
  it('inflates method-8 entries (GitHub zipballs use deflate)', () => {
    const content = Buffer.from('deflated content '.repeat(10))
    const compressed = deflateRawSync(content)
    const name = Buffer.from('file.md')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(content), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(content), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 42)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(central.length + name.length, 12)
    eocd.writeUInt32LE(local.length + name.length + compressed.length, 16)
    const zip = Buffer.concat([local, name, compressed, central, name, eocd])
    const entries = readZipEntries(zip)
    expect(entries[0]!.data.equals(content)).toBe(true)
  })
})
