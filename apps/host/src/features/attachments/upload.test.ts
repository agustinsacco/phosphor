import type * as NodeFs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS as LIMIT } from '@phosphor/shared/host-protocol-attachments'
import { createAttachmentState, type AttachmentState } from './state'
import { close, directory } from './storage'
import { execute } from './upload'

const io = vi.hoisted(() => ({ fail: '', writes: 0, short: false }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      if (typeof args[1] === 'string') return fs.writeSync(...args)
      io.writes++
      if (io.fail === 'write' && io.writes === 2) throw new Error('injected')
      if (io.short || io.fail === 'write') return fs.writeSync(args[0], args[1], args[2], 1)
      return fs.writeSync(...args)
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      if (io.fail === 'read') return 0
      return fs.readSync(...args)
    },
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
      if (io.fail === 'fsync') throw new Error('injected')
      return fs.fsyncSync(...args)
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (io.fail === 'rename') throw new Error('injected')
      return fs.renameSync(...args)
    },
  }
})
let state: AttachmentState
const owner = { laneId: randomUUID(), clientId: randomUUID(), fence: 2 }
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const begin = (size = 3) =>
  ({ type: 'attachments.begin', size, name: '../a b.pdf', mime: 'application/pdf' }) as const
const chunk = (uploadId: string, index = 0) =>
  ({ type: 'attachments.chunk', uploadId, index, data: 'YWJj' }) as const
const commit = (uploadId: string, sha256 = hash('abc')) =>
  ({ type: 'attachments.commit', uploadId, sha256 }) as const
const temp = () => join(state.temporary, owner.laneId)
async function start(size = 3) {
  const result = await execute(state, owner, begin(size))
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
  io.fail = ''
  io.writes = 0
  io.short = false
  state = createAttachmentState({
    directory: realpathSync(mkdtempSync(join(tmpdir(), 'attachment-upload-'))),
    laneExists: () => true,
  })
  directory(state.root)
  directory(state.temporary)
})
afterEach(() => {
  close(state)
  rmSync(state.ports.directory, { recursive: true, force: true })
})

it('executes all filesystem transitions synchronously before its returned promise resolves', async () => {
  const pending = execute(state, owner, begin())
  expect(state.uploads.size).toBe(1)
  const id = [...state.uploads.keys()][0]!
  await pending
  io.short = true
  const received = execute(state, owner, chunk(id))
  expect(state.uploads.get(id)).toMatchObject({ received: 3, index: 1 })
  expect(readFileSync(join(temp(), id), 'utf8')).toBe('abc')
  expect(io.writes).toBe(3)
  await received
  const committed = execute(state, owner, commit(id))
  expect(state.uploads.size).toBe(0)
  const path = join(state.root, owner.laneId, `${id}-.._a_b.pdf`)
  expect(readFileSync(path, 'utf8')).toBe('abc')
  expect(await committed).toEqual({ ok: true, data: { path } })
})
it('cleans up partial chunk writes without advancing or leaving resumable upload state', async () => {
  const id = await start()
  const upload = state.uploads.get(id)!
  io.fail = 'write'
  expect(await execute(state, owner, chunk(id))).toEqual({ ok: false, code: 'bad-request' })
  expect(io.writes).toBe(2)
  expect(upload).toMatchObject({ received: 0, index: 0 })
  expect(state.uploads.size).toBe(0)
  expect(readdirSync(temp())).toEqual([])
})
it.each(['read', 'fsync', 'rename'])(
  'discards failed commits and any reserved destination after %s failure',
  async (operation) => {
    const id = await start()
    await execute(state, owner, chunk(id))
    io.fail = operation
    expect(await execute(state, owner, commit(id))).toEqual({ ok: false, code: 'bad-request' })
    expect(state.uploads.size).toBe(0)
    expect(readdirSync(temp())).toEqual([])
    expect(readdirSync(join(state.root, owner.laneId))).toEqual(['.quota'])
  },
)
it('rejects invalid input and mismatched owners without consuming an otherwise valid upload', async () => {
  const id = await start()
  expect(await execute(state, owner, chunk(id, -1))).toMatchObject({ ok: false })
  for (const other of [
    { ...owner, clientId: randomUUID() },
    { ...owner, laneId: randomUUID() },
    { ...owner, fence: 3 },
  ])
    expect(await execute(state, other, chunk(id))).toMatchObject({ ok: false })
  expect(state.uploads.size).toBe(1)
  expect(await execute(state, owner, chunk(id))).toEqual({ ok: true })
})
it('enforces concurrent file limits before charging quota and commits empty files', async () => {
  for (let i = 0; i < LIMIT.files; i++) await start(0)
  const ledger = join(state.root, owner.laneId, '.quota')
  const prior = readFileSync(ledger, 'utf8')
  expect(await execute(state, owner, begin(0))).toMatchObject({ ok: false })
  expect(readFileSync(ledger, 'utf8')).toBe(prior)
  const id = [...state.uploads.keys()][0]!
  expect(await execute(state, owner, commit(id, hash('')))).toMatchObject({ ok: true })
})
it('refuses on-disk size changes and final destination collisions without replacing existing bytes', async () => {
  const changed = await start()
  writeFileSync(join(temp(), changed), 'changed')
  expect(await execute(state, owner, chunk(changed))).toMatchObject({ ok: false })
  const id = await start()
  await execute(state, owner, chunk(id))
  const path = join(state.root, owner.laneId, `${id}-.._a_b.pdf`)
  writeFileSync(path, 'keep')
  expect(await execute(state, owner, commit(id))).toMatchObject({ ok: false })
  expect(readFileSync(path, 'utf8')).toBe('keep')
})
