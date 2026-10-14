import { Buffer } from 'node:buffer'
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { contract } from './common.mjs'

/** Minimal ustar writer: sorted regular files, no links, stable metadata and gzip header. */
export function archive(folder) {
  const parts = []
  let total = 0
  let count = 0
  for (const path of readdirSync(folder, { recursive: true }).sort()) {
    const full = join(folder, path)
    const stat = lstatSync(full)
    if (stat.isDirectory()) continue
    total += stat.size
    if (
      !stat.isFile() ||
      Buffer.byteLength(path) > 100 ||
      ++count > 4096 ||
      total > contract.HOST_RELEASE_ARTIFACT_MAX_BYTES
    )
      throw new Error('Unsupported bundle entry')
    const data = readFileSync(full)
    const header = Buffer.alloc(512)
    const text = (value, offset, size) => header.write(value, offset, size, 'ascii')
    const octal = (value, offset, size) =>
      text(value.toString(8).padStart(size - 1, '0') + '\0', offset, size)
    text(path, 0, 100)
    octal(
      path === 'bin/phosphor' ||
        path === 'node/bin/node' ||
        path === 'lib/native/node-pty/build/Release/spawn-helper'
        ? 0o755
        : 0o644,
      100,
      8,
    )
    octal(0, 108, 8)
    octal(0, 116, 8)
    octal(data.length, 124, 12)
    octal(0, 136, 12)
    header.fill(32, 148, 156)
    text('0', 156, 1)
    text('ustar\0', 257, 6)
    text('00', 263, 2)
    const sum = header.reduce((a, b) => a + b, 0)
    text(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]), { level: 9 })
}
