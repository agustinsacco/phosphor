import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { scanLines } from './lines'

it.each(['\r\n', '\r'])(
  'does not charge the delimiter CR against a full-sized record: %j',
  (delimiter) => {
    const root = mkdtempSync(join(tmpdir(), 'preview-crlf-'))
    const fd = openSync(join(root, 'fixture'), 'w+')
    const size = 32 * 1024 * 1024
    try {
      // The CR is the last byte of one scanner chunk and LF is in the next.
      const prefix = Buffer.alloc(256 * 1024 - 1, ' ')
      prefix[prefix.length - 1] = 10
      writeSync(fd, prefix)
      writeSync(fd, Buffer.alloc(size, 'a'))
      writeSync(fd, delimiter)
      const lengths: number[] = []
      scanLines(fd, prefix.length + size + delimiter.length, (line, range) => {
        expect(range.length).toBe(line.length)
        lengths.push(line.length)
      })
      expect(lengths).toEqual([prefix.length - 1, size])
    } finally {
      closeSync(fd)
      rmSync(root, { recursive: true, force: true })
    }
  },
)
