import { expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS as L, type AttachmentOp } from '@shared/host-protocol-attachments'
import type { FileWriteOp } from '@shared/host-protocol-writes'
import { uploadAttachments } from './attachments'
import type { WriteLane } from './write-features'
const id = 'a'.repeat(32)
const file = (data = 'abc') => ({
  name: 'report.pdf',
  mime: 'application/pdf',
  data: Buffer.from(data).toString('base64'),
})
function setup() {
  const write = vi.fn(async (op: AttachmentOp | FileWriteOp): Promise<unknown> => {
    if (op.type === 'attachments.begin') return { uploadId: id }
    if (op.type === 'attachments.commit') return { path: '/host/attachments/report.pdf' }
    return undefined
  })
  const lane: WriteLane = { laneId: 'lane', workspacePath: 'host:workspace', call: vi.fn(), write }
  return { lane, write }
}
it('uploads in bounded ordered receipt chunks, then commits exact sha256', async () => {
  const t = setup()
  const bytes = Buffer.alloc(L.chunkBytes + 1, 1)
  expect(await uploadAttachments([{ ...file(), data: bytes.toString('base64') }], t.lane)).toEqual([
    '/host/attachments/report.pdf',
  ])
  expect(t.write.mock.calls.map(([op]) => op.type)).toEqual([
    'attachments.begin',
    'attachments.chunk',
    'attachments.chunk',
    'attachments.commit',
  ])
  expect(t.write.mock.calls[1]?.[0]).toMatchObject({ index: 0, uploadId: id })
  expect(t.write.mock.calls[2]?.[0]).toMatchObject({ index: 1, data: 'AQ==' })
  expect(t.write.mock.calls[3]?.[0]).toMatchObject({
    sha256: 'bd2186d146818af59eaa9f47a3336033d22552bd15c3a122e5f281d8b0e9b5dd',
  })
})
it('validates the whole batch before any begin, including exact keys and ten files', async () => {
  const t = setup()
  for (const input of [
    Array(11).fill(file()),
    [file(), { ...file(), path: '/host/path' }],
    [{ ...file(), data: 'invalid' }],
    [{ ...file(), data: Buffer.alloc(L.fileBytes + 1).toString('base64') }],
    Array(4).fill({ ...file(), data: Buffer.alloc(L.fileBytes).toString('base64') }),
  ])
    await expect(uploadAttachments(input, t.lane)).rejects.toThrow()
  expect(t.write).not.toHaveBeenCalled()
})
it.each(['begin', 'chunk', 'commit'] as const)(
  'rejects untrusted %s results and never proceeds',
  async (stage) => {
    const t = setup()
    t.write.mockImplementation(async (op) => {
      if (op.type === 'attachments.begin')
        return stage === 'begin' ? { uploadId: '../path' } : { uploadId: id }
      if (op.type === 'attachments.chunk') return stage === 'chunk' ? {} : undefined
      return { uploadId: id }
    })
    await expect(uploadAttachments([file()], t.lane)).rejects.toThrow()
    expect(t.write).toHaveBeenCalledTimes(stage === 'begin' ? 1 : stage === 'chunk' ? 2 : 3)
  },
)
it('never resends after an unknown chunk and does not upload later files', async () => {
  const t = setup()
  t.write.mockImplementation(async (op) => {
    if (op.type === 'attachments.begin') return { uploadId: id }
    throw new Error('File mutation not confirmed.')
  })
  await expect(uploadAttachments([file(), file()], t.lane)).rejects.toThrow('not confirmed')
  expect(t.write).toHaveBeenCalledTimes(2)
})
