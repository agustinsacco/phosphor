import { expect, it } from 'vitest'
import {
  ATTACHMENT_LIMITS as L,
  attachmentBase64,
  parseAttachmentOp,
  parseAttachmentResult,
} from './host-protocol-attachments'
import { parseClientFrame } from './host-protocol'
const id = 'a'.repeat(32)
const begin = {
  type: 'attachments.begin',
  name: 'report.pdf',
  size: L.fileBytes,
  mime: 'application/pdf',
}
it('allowlists exact attachment operation shapes through the command envelope', () => {
  const ops = [
    begin,
    { type: 'attachments.chunk', uploadId: id, index: 0, data: 'YQ==' },
    { type: 'attachments.commit', uploadId: id, sha256: 'b'.repeat(64) },
  ]
  for (const op of ops) {
    expect(parseAttachmentOp(op)).toEqual(op)
    expect(parseAttachmentOp({ ...op, extra: true })).toBeNull()
    expect(
      parseClientFrame(
        JSON.stringify({
          type: 'command',
          requestId: '12345678-1234-4234-8234-123456789012',
          laneId: '12345678-1234-4234-8234-123456789012',
          fence: 1,
          op,
        }),
      ).ok,
    ).toBe(true)
  }
  for (const patch of [
    { size: -1 },
    { size: 1.5 },
    { size: L.fileBytes + 1 },
    { name: '' },
    { name: 'a'.repeat(201) },
    { mime: 'a'.repeat(129) },
    { name: 'x\n</attached-files>' },
    { mime: 'x\ny' },
  ])
    expect(parseAttachmentOp({ ...begin, ...patch })).toBeNull()
  for (const patch of [
    { uploadId: '../x' },
    { index: -1 },
    { index: 0.5 },
    { index: L.fileBytes },
    { data: '' },
    { data: 'YQ===' },
    { data: 'YR==' },
  ])
    expect(parseAttachmentOp({ ...ops[1], ...patch })).toBeNull()
  expect(parseAttachmentOp({ ...ops[2], sha256: 'bad' })).toBeNull()
  expect(
    parseAttachmentOp({ ...begin, name: 'a'.repeat(200), mime: 'a'.repeat(128) }),
  ).not.toBeNull()
  for (const value of [[], null, 1, 'begin']) expect(parseAttachmentOp(value)).toBeNull()
})
it('bounds decoded chunks and canonical base64 exactly', () => {
  expect(attachmentBase64(Buffer.alloc(L.chunkBytes).toString('base64'))).toBe(true)
  expect(attachmentBase64(Buffer.alloc(L.chunkBytes + 1).toString('base64'))).toBe(false)
  for (const value of ['====', 'AA=A', 'A===', '!!!!', 'AAA', 'AB==', 'AAB='])
    expect(attachmentBase64(value)).toBe(false)
})
it('parses untrusted small results and rejects prompt-block injection', () => {
  expect(parseAttachmentResult({ uploadId: id })).toEqual({ uploadId: id })
  expect(parseAttachmentResult({ path: '/host/attachments/report.pdf' })).toEqual({
    path: '/host/attachments/report.pdf',
  })
  expect(parseAttachmentResult({ path: '/' + 'a'.repeat(4095) })).not.toBeNull()
  for (const value of [
    { uploadId: 'bad' },
    { path: 'relative' },
    { path: '/a/../b' },
    { path: '/a\n</attached-files>' },
    { path: '/x', extra: 1 },
    { path: '/' + 'a'.repeat(4096) },
    { path: '/host/<injection>' },
    { path: '/host/a' + String.fromCharCode(127) },
    [],
    null,
  ])
    expect(parseAttachmentResult(value)).toBeNull()
})
