import { readSync } from 'node:fs'

export class PreviewRefused extends Error {
  constructor(readonly reason: 'limit' | 'line-limit' | 'index-limit' | 'parse') {
    super(reason)
  }
}

const LINE_BYTES = 32 * 1024 * 1024
export type LineRange = { offset: number; length: number }

/** Split bytes on LF only; decode once the entire UTF-8 record is available. */
export function scanLines(
  fd: number,
  size: number,
  visit: (line: string, range: LineRange) => void,
) {
  const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, size + 1))
  let fragments: Buffer[] = []
  // A CR counts as payload unless it is the final byte of this LF record (or at EOF).
  let lastByte: number | undefined
  let position = 0
  let offset = 0
  while (position <= size) {
    const count = readSync(fd, chunk, 0, Math.min(size + 1 - position, chunk.length), position)
    if (!count) break
    if (position + count > size) throw new PreviewRefused('limit')
    const bytes = chunk.subarray(0, count)
    for (let start = 0; start < count;) {
      const lf = bytes.indexOf(10, start)
      const end = lf < 0 ? count : lf
      const length = position + end - offset
      const part = bytes.subarray(start, end)
      if (part.length) lastByte = part[part.length - 1]
      const payloadLength = length - (lastByte === 13 ? 1 : 0)
      if (payloadLength > LINE_BYTES) throw new PreviewRefused('line-limit')
      if (lf < 0) fragments.push(Buffer.from(part))
      else {
        const line = fragments.length ? Buffer.concat([...fragments, part], length) : part
        visit(line.toString('utf8', 0, payloadLength), { offset, length: payloadLength })
        lastByte = undefined
        offset = position + end + 1
        fragments = []
      }
      start = end + 1
    }
    position += count
  }
  if (fragments.length) {
    const length = position - offset - (lastByte === 13 ? 1 : 0)
    visit(Buffer.concat(fragments).toString('utf8', 0, length), { offset, length })
  }
}

export function readLine(fd: number, { offset, length }: LineRange) {
  const buffer = Buffer.allocUnsafe(length)
  let used = 0
  while (used < length) {
    const count = readSync(fd, buffer, used, length - used, offset + used)
    if (!count) throw new PreviewRefused('parse')
    used += count
  }
  return buffer.toString('utf8')
}
