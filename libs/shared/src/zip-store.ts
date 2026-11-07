/**
 * The STORE-method (uncompressed) zip writer for skill bundles, over plain bytes so Desktop
 * main and a browser page share it. Skill bundles are kilobytes of markdown; simplicity beats
 * ratio. The reader, the security boundary for imports, stays in Desktop main (`pi/zip.ts`).
 */
import { base64ToBytes } from './base64'
import { parseSkillBundle } from './host-protocol-skill-share'

export interface ZipStoreEntry {
  /** Forward-slash relative path. */
  path: string
  data: Uint8Array
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** Build a STORE-method zip from file entries, with UTF-8 names. */
export function writeZipStore(entries: ZipStoreEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const names = entries.map((entry) => encoder.encode(entry.path))
  const localSize = entries.reduce((sum, e, i) => sum + 30 + names[i]!.length + e.data.length, 0)
  const centralSize = names.reduce((sum, name) => sum + 46 + name.length, 0)
  const zip = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(zip.buffer)
  let offset = 0
  let central = localSize
  entries.forEach((entry, index) => {
    const name = names[index]!
    const crc = crc32(entry.data)
    view.setUint32(offset, LOCAL_SIG, true)
    view.setUint16(offset + 4, 20, true) // version needed
    view.setUint16(offset + 6, 0x0800, true) // utf8 names
    view.setUint32(offset + 14, crc, true) // the method at offset 8 stays 0: store
    view.setUint32(offset + 18, entry.data.length, true)
    view.setUint32(offset + 22, entry.data.length, true)
    view.setUint16(offset + 26, name.length, true)
    zip.set(name, offset + 30)
    zip.set(entry.data, offset + 30 + name.length)
    view.setUint32(central, CENTRAL_SIG, true)
    view.setUint16(central + 4, 20, true)
    view.setUint16(central + 6, 20, true)
    view.setUint16(central + 8, 0x0800, true)
    view.setUint32(central + 16, crc, true)
    view.setUint32(central + 20, entry.data.length, true)
    view.setUint32(central + 24, entry.data.length, true)
    view.setUint16(central + 28, name.length, true)
    view.setUint32(central + 42, offset, true)
    zip.set(name, central + 46)
    offset += 30 + name.length + entry.data.length
    central += 46 + name.length
  })
  view.setUint32(central, EOCD_SIG, true)
  view.setUint16(central + 8, entries.length, true)
  view.setUint16(central + 10, entries.length, true)
  view.setUint32(central + 12, centralSize, true)
  view.setUint32(central + 16, localSize, true)
  return zip
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * A skill bundle as the zip Export saves, laid out `<name>/<path>` as This Mac's export is.
 * The bundle is validated first: a caller-supplied one is never trusted.
 */
export function zipSkillBundle(value: unknown): {
  fileName: string
  data: Uint8Array<ArrayBuffer>
} {
  const bundle = parseSkillBundle(value)
  if (!bundle) throw new Error('This skill bundle is not valid.')
  const entries = bundle.files.map((file) => ({
    path: `${bundle.name}/${file.path}`,
    data: base64ToBytes(file.data),
  }))
  return { fileName: `${bundle.name}.zip`, data: writeZipStore(entries) }
}
