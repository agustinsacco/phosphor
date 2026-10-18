import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS as LIMIT } from '@phosphor/shared/host-protocol-attachments'
import { createAttachments, type HostAttachments } from './attachments'

let directory: string
let now: number
let service: HostAttachments
const owner = { laneId: randomUUID(), clientId: randomUUID(), fence: 7 }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const begin = (size = 3) =>
  ({ type: 'attachments.begin', name: 'report.pdf', size, mime: 'application/pdf' }) as const
const chunk = (uploadId: string, index = 0) =>
  ({ type: 'attachments.chunk', uploadId, index, data: 'YWJj' }) as const
const commit = (uploadId: string, sha256 = digest('abc')) =>
  ({ type: 'attachments.commit', uploadId, sha256 }) as const
const temporary = () => join(directory, 'attachments-tmp', owner.laneId)
const ledger = () => join(directory, 'attachments', owner.laneId, '.quota')
function open(laneExists = (_id: string) => true) {
  return createAttachments({ directory, now: () => now, laneExists })
}
async function start(size = 3) {
  const result = await service.execute(owner, begin(size))
  if (
    !result.ok ||
    typeof result.data !== 'object' ||
    result.data === null ||
    !('uploadId' in result.data) ||
    typeof result.data.uploadId !== 'string'
  )
    throw new Error('missing upload')
  return result.data.uploadId
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'attachments-contract-')))
  now = Date.now()
  service = open()
})
afterEach(() => {
  service.close()
  rmSync(directory, { recursive: true, force: true })
})

it('binds every upload to its lane, client and fence without aborting on owner mismatch', async () => {
  const id = await start()
  for (const other of [
    { ...owner, laneId: randomUUID() },
    { ...owner, clientId: randomUUID() },
    { ...owner, fence: owner.fence + 1 },
  ]) {
    expect(await service.execute(other, chunk(id))).toEqual({ ok: false, code: 'bad-request' })
    expect(await service.execute(other, commit(id))).toEqual({ ok: false, code: 'bad-request' })
  }
  expect(await service.execute(owner, chunk(id))).toEqual({ ok: true })
  expect(await service.execute(owner, commit(id))).toMatchObject({ ok: true })
})
it('aborts a bad chunk and makes subsequent operations indistinguishable from missing uploads', async () => {
  const id = await start()
  expect(await service.execute(owner, chunk(id, 1))).toEqual({ ok: false, code: 'bad-request' })
  expect(readdirSync(temporary())).toEqual([])
  expect(await service.execute(owner, chunk(id))).toEqual({ ok: false, code: 'bad-request' })
  expect(await service.execute(owner, commit(id))).toEqual({ ok: false, code: 'bad-request' })
})
it('checks received and on-disk digests and exclusively reserves the final name', async () => {
  const wrong = await start()
  await service.execute(owner, chunk(wrong))
  expect(await service.execute(owner, commit(wrong, digest('def')))).toMatchObject({ ok: false })
  const edited = await start()
  await service.execute(owner, chunk(edited))
  writeFileSync(join(temporary(), edited), 'def')
  expect(await service.execute(owner, commit(edited))).toMatchObject({ ok: false })
  const occupied = await start()
  await service.execute(owner, chunk(occupied))
  const destination = join(directory, 'attachments', owner.laneId, `${occupied}-report.pdf`)
  writeFileSync(destination, 'keep')
  expect(await service.execute(owner, commit(occupied))).toMatchObject({ ok: false })
  expect(readFileSync(destination, 'utf8')).toBe('keep')
  const good = await start()
  await service.execute(owner, chunk(good))
  expect(await service.execute(owner, commit(good))).toEqual({
    ok: true,
    data: { path: join(directory, 'attachments', owner.laneId, `${good}-report.pdf`) },
  })
  expect(readdirSync(temporary())).toEqual([])
})
it('persists quota across restart and backwards time through all sixty-one minute buckets', async () => {
  now = 120000
  for (const bytes of [LIMIT.fileBytes, LIMIT.fileBytes, LIMIT.fileBytes, 4 * 1024 * 1024]) {
    await start(bytes)
    service.abort(owner.laneId)
  }
  service.close()
  service = open()
  now -= 60000
  expect(await service.execute(owner, begin(0))).toEqual({ ok: false, code: 'bad-request' })
  now = 120000 + 60 * 60000 + 59999
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
  now++
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: true })
  const buckets: unknown[] = JSON.parse(readFileSync(ledger(), 'utf8'))
  expect(buckets).toHaveLength(61)
})
it('charges a full hour for malformed or missing ledgers beside an existing lane directory', async () => {
  await start(0)
  service.abort(owner.laneId)
  writeFileSync(ledger(), 'not-json')
  service.close()
  service = open()
  expect(await service.execute(owner, begin(0))).toEqual({ ok: false, code: 'bad-request' })
  now += 61 * 60000
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: true })
  service.abort(owner.laneId)
  rmSync(ledger())
  expect(await service.execute(owner, begin(0))).toEqual({ ok: false, code: 'bad-request' })
})
it('expires active and startup orphan files without following temporary symlinks', async () => {
  await start()
  now += LIMIT.lifetimeMs
  service.sweep()
  expect(readdirSync(temporary())).toEqual([])
  service.close()
  const orphan = 'a'.repeat(32)
  writeFileSync(join(temporary(), orphan), 'partial')
  const outside = join(directory, 'keep')
  writeFileSync(outside, 'safe')
  symlinkSync(outside, join(temporary(), 'b'.repeat(32)))
  now = Date.now() + LIMIT.lifetimeMs + 1000
  service = open()
  expect(readdirSync(temporary())).toEqual(['b'.repeat(32)])
  expect(readFileSync(outside, 'utf8')).toBe('safe')
})
it('removes unknown lane trees without traversing links and skips symlink lane entries', () => {
  service.close()
  const outside = join(directory, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'keep'), 'safe')
  const removed = randomUUID()
  const lane = join(directory, 'attachments', removed)
  mkdirSync(lane)
  symlinkSync(outside, join(lane, 'nested'))
  const linked = randomUUID()
  symlinkSync(outside, join(directory, 'attachments-tmp', linked))
  service = open((id) => id === owner.laneId)
  expect(readdirSync(join(directory, 'attachments'))).not.toContain(removed)
  expect(readdirSync(join(directory, 'attachments-tmp'))).toContain(linked)
  service.remove(linked)
  expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('safe')
})
