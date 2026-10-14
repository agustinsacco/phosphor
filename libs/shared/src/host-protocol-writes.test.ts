import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { parseFileWriteOp, parseWriteResult } from './host-protocol-writes'
import { FILE_LIMITS, parseFileResult } from './host-protocol-files'
import { parseClientFrame } from './host-protocol'

it('accepts only bounded exact write ops and rejects traversal and metadata', () => {
  const op = {
    type: 'files.write',
    path: 'a',
    content: 'é'.repeat(FILE_LIMITS.textBytes / 2),
    expected: null,
  }
  expect(parseFileWriteOp(op)).toEqual(op)
  expect(parseFileWriteOp({ ...op, content: op.content + 'é' })).toBeNull()
  for (const path of ['/etc/a', '../a', '.git/a', 'a/.GIT/b', 'a//b', 'a\\b', 'a\0', 'a/./b'])
    expect(parseFileWriteOp({ ...op, path })).toBeNull()
  for (const expected of [undefined, '', 'a'.repeat(63), 'G'.repeat(64), 0])
    expect(parseFileWriteOp({ ...op, expected })).toBeNull()
  expect(parseFileWriteOp({ ...op, extra: true })).toBeNull()
  for (const input of [
    { type: 'files.create', path: 'a', kind: 'file' },
    { type: 'files.create', path: 'a', kind: 'directory' },
    { type: 'files.rename', from: 'a', to: 'b' },
    { type: 'files.delete', path: 'a' },
    { type: 'files.transfer', source: 'a', directory: '.', mode: 'copy' },
    { type: 'files.transfer', source: 'a', directory: 'folder', mode: 'move' },
  ]) {
    expect(parseFileWriteOp(input)).toEqual(input)
    expect(parseFileWriteOp({ ...input, extra: true })).toBeNull()
    expect(
      parseClientFrame(
        JSON.stringify({
          type: 'command',
          requestId: randomUUID(),
          laneId: randomUUID(),
          fence: 1,
          op: input,
        }),
      ).ok,
    ).toBe(true)
  }
  expect(parseFileWriteOp({ type: 'files.create', path: 'a', kind: 'symlink' })).toBeNull()
  expect(
    parseFileWriteOp({ type: 'files.transfer', source: 'a', directory: '.', mode: 'exec' }),
  ).toBeNull()
})
it('validates revisions and result paths without trusting a Host', () => {
  const revision = 'a'.repeat(64)
  expect(parseWriteResult({ revision, mtimeMs: 0 })).toEqual({ revision, mtimeMs: 0 })
  expect(parseWriteResult({ revision, mtimeMs: -1 })).toBeNull()
  expect(parseWriteResult({ revision, mtimeMs: 0, content: 'secret' })).toBeNull()
  expect(parseWriteResult({ path: '/host/path' })).toBeNull()
  expect(parseWriteResult({ path: 'a' })).toEqual({ path: 'a' })
  expect(
    parseFileResult('files.read', { binary: false, size: 0, content: '', revision: null }),
  ).not.toBeNull()
  expect(parseFileResult('files.read', { binary: false, size: 1, content: 'x' })).toBeNull()
})
