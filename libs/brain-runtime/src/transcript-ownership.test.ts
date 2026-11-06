import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { assertPurgeOwnership } from './transcript-ownership'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const owner = (jobId = 'job') =>
  JSON.stringify({
    type: 'custom',
    customType: 'phosphor-brain-owner',
    data: { kind: 'brain', jobId },
  })
async function validate(text: string, chunkBytes?: number): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'brain-owner-stream-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'processor.jsonl')
  await writeFile(path, text)
  const file = await open(path, 'r')
  if (chunkBytes) {
    const stream = file.createReadStream.bind(file)
    vi.spyOn(file, 'createReadStream').mockImplementation((options) =>
      stream({ ...options, highWaterMark: chunkBytes }),
    )
  }
  try {
    await assertPurgeOwnership(file, 'job')
  } finally {
    await file.close()
  }
}
it('handles reordered and escaped owner fields split at every byte, including multibyte payloads', async () => {
  const escaped = String.raw`{"data":{"jobId":"\u006aob","\u006bind":"brain"},"custom\u0054ype":"phosphor-brain-owner","\u0074ype":"custom"}`
  const body = JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: '漢\u2028\\"text' },
    array: [true, false, null, -1.25e4],
  })
  await expect(validate(escaped + '\n' + body + '\n' + owner(), 1)).resolves.toBeUndefined()
})
it('streams an arbitrarily long single message string without mistaking fake owners for metadata', async () => {
  const content = '漢'.repeat(750000) + owner('foreign')
  await expect(
    validate(owner() + '\n' + JSON.stringify({ type: 'message', message: { content } }) + '\n'),
  ).resolves.toBeUndefined()
})
it('rejects foreign owners after an oversized payload and never counts fake owner text in strings', async () => {
  const message = JSON.stringify({
    type: 'message',
    message: { content: 'x'.repeat(2_100_000) + owner() },
  })
  await expect(validate(message + '\n')).rejects.toThrow('ownership')
  await expect(validate(owner() + '\n' + message + '\n' + owner('foreign') + '\n')).rejects.toThrow(
    'ownership',
  )
})
it.each([
  '{"type":"custom","customType":"phosphor-brain-owner","data":{"kind":"brain","jobId":"foreign","jobId":"job"}}',
  '{"type":"custom","customType":"phosphor-brain-owner","data":null}',
  '{"type":"message","customType":"phosphor-brain-owner","data":{"kind":"brain","jobId":"job"}}',
  '{"type":"message","message":{"content":"bad\\q"}}',
  '{"type":"message","message":[1,]}',
  '{"type":"message","message":[01]}',
  '{"type":"message","message":trueX}',
  '{"type":"message"}\n{"type":"message",',
])('fails closed on malformed ownership/JSON: %s', async (row) => {
  await expect(validate(owner() + '\n' + row + '\n', 7)).rejects.toThrow()
})
