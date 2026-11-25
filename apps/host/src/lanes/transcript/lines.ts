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
      if (length > LINE_BYTES) throw new PreviewRefused('line-limit')
      const part = bytes.subarray(start, end)
      if (lf < 0) fragments.push(Buffer.from(part))
      else {
        const line = fragments.length ? Buffer.concat([...fragments, part], length) : part
        visit(line.toString('utf8'), { offset, length })
        offset = position + end + 1
        fragments = []
      }
      start = end + 1
    }
    position += count
  }
  if (fragments.length)
    visit(Buffer.concat(fragments).toString('utf8'), { offset, length: position - offset })
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
