import { describe, expect, it } from 'vitest'
import { crc32, writeZipStore, zipSkillBundle } from './zip-store'

/** The entries a STORE zip lists, read back through its central directory. */
function storedEntries(zip: Uint8Array): { path: string; text: string; crc: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const eocd = zip.byteLength - 22
  expect(view.getUint32(eocd, true)).toBe(0x06054b50)
  let central = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  return Array.from({ length: view.getUint16(eocd + 10, true) }, () => {
    expect(view.getUint32(central, true)).toBe(0x02014b50)
    expect(view.getUint16(central + 10, true)).toBe(0)
    const size = view.getUint32(central + 24, true)
    const nameLength = view.getUint16(central + 28, true)
    const local = view.getUint32(central + 42, true)
    expect(view.getUint32(local, true)).toBe(0x04034b50)
    const path = decoder.decode(zip.subarray(central + 46, central + 46 + nameLength))
    const start = local + 30 + view.getUint16(local + 26, true)
    const data = zip.subarray(start, start + size)
    expect(view.getUint32(central + 16, true)).toBe(crc32(data))
    central += 46 + nameLength
    return { path, text: decoder.decode(data), crc: crc32(data) }
  })
}

describe('writeZipStore', () => {
  it('round-trips entries through the central directory', () => {
    const zip = writeZipStore([
      { path: 'demo/SKILL.md', data: new TextEncoder().encode('---\nname: demo\n---\nbody') },
      { path: 'demo/références/notes.md', data: new TextEncoder().encode('notes') },
    ])
    expect(storedEntries(zip).map(({ path, text }) => [path, text])).toEqual([
      ['demo/SKILL.md', '---\nname: demo\n---\nbody'],
      ['demo/références/notes.md', 'notes'],
    ])
  })

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('zipSkillBundle', () => {
  it('lays a bundle out under its name, as This Mac exports a skill', () => {
    const { fileName, data } = zipSkillBundle({
      name: 'demo',
      files: [
        { path: 'SKILL.md', data: btoa('skill') },
        { path: 'refs/a.md', data: btoa('a') },
      ],
    })
    expect(fileName).toBe('demo.zip')
    expect(storedEntries(data).map(({ path, text }) => [path, text])).toEqual([
      ['demo/SKILL.md', 'skill'],
      ['demo/refs/a.md', 'a'],
    ])
  })

  it.each([
    ['an escaping path', { name: 'demo', files: [{ path: '../SKILL.md', data: btoa('x') }] }],
    ['no SKILL.md', { name: 'demo', files: [{ path: 'a.md', data: btoa('x') }] }],
    ['a bad name', { name: '../demo', files: [{ path: 'SKILL.md', data: btoa('x') }] }],
    ['extra keys', { name: 'demo', files: [], extra: true }],
  ])('refuses %s before zipping', (_label, bundle) => {
    expect(() => zipSkillBundle(bundle)).toThrow('This skill bundle is not valid.')
  })
})
