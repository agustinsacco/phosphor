import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { HOST_RELEASE_ARTIFACT_MAX_BYTES } from '@phosphor/shared/host-release'

export function decompressRelease(
  bytes: Buffer,
  maxBytes = HOST_RELEASE_ARTIFACT_MAX_BYTES,
): Buffer {
  return gunzipSync(bytes, { maxOutputLength: Math.min(maxBytes, HOST_RELEASE_ARTIFACT_MAX_BYTES) })
}
/** Only the builder's ustar regular-file paths are accepted. Never invoke system tar. */
export function extractRelease(
  tar: Buffer,
  folder: string,
  maxBytes = HOST_RELEASE_ARTIFACT_MAX_BYTES,
): void {
  if (tar.length % 512 !== 0) throw new Error('Invalid release archive')
  let offset = 0
  let count = 0
  const names = new Set<string>()
  const fail = (): never => {
    throw new Error('Invalid release archive')
  }
  const octal = (field: Buffer): number => {
    const text = field
      .toString('utf8')
      .replace(/[\0 ]+$/, '')
      .trim()
    if (!/^[0-7]+$/.test(text)) fail()
    const n = parseInt(text, 8)
    if (!Number.isSafeInteger(n)) fail()
    return n
  }
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512)
    if (h.every((b) => b === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every((b) => b === 0) || count === 0)
        fail()
      return
    }
    if (++count > 4096) fail()
    const nameBytes = h.subarray(0, 100)
    const end = nameBytes.indexOf(0)
    const name = nameBytes.subarray(0, end < 0 ? 100 : end).toString('utf8')
    if (
      !/^(bin\/phosphor|node\/bin\/node|node\/LICENSE|VERSION|lib\/[-A-Za-z0-9_./]+)$/.test(name) ||
      /(^|\/)\.\.?($|\/)/.test(name) ||
      name.includes('//') ||
      names.has(name) ||
      (end >= 0 && !nameBytes.subarray(end).every((b) => b === 0)) ||
      !h.subarray(345, 500).every((b) => b === 0) ||
      !h.subarray(157, 257).every((b) => b === 0) ||
      h.subarray(257, 263).toString() !== 'ustar\0' ||
      h.subarray(263, 265).toString() !== '00'
    )
      fail()
    names.add(name)
    const checksum = h.reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0)
    if (octal(h.subarray(148, 156)) !== checksum) fail()
    const size = octal(h.subarray(124, 136))
    const type = h[156]
    // The installer accepts no directory entries; parents are created from file names.
    if (type !== 0 && type !== 48) fail()
    offset += 512
    const padded = Math.ceil(size / 512) * 512
    if (padded > tar.length - offset || size > maxBytes - offset) fail()
    const path = join(folder, name)
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
    for (let parent = dirname(path); parent.length > folder.length; parent = dirname(parent))
      chmodSync(parent, 0o755)
    const mode = name === 'bin/phosphor' || name === 'node/bin/node' ? 0o755 : 0o644
    writeFileSync(path, tar.subarray(offset, offset + size), {
      flag: 'wx',
      mode,
    })
    chmodSync(path, mode)
    offset += padded
  }
  fail()
}
