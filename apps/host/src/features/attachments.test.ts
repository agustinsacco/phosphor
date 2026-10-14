import type * as NodeFs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
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
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ATTACHMENT_LIMITS as L } from '@phosphor/shared/host-protocol-attachments'
import { createAttachments, type HostAttachments } from './attachments'
import {
  createLaneCommands,
  type LaneCommandClient,
  type LaneCommandFrame,
} from '../lanes/commands'
import { openStore } from '../lanes/store'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { HOST_LIMITS, type Receipt } from '@phosphor/shared/host-protocol'
const failures = vi.hoisted(() => ({ operation: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  return {
    ...fs,
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      if (failures.operation === 'write') throw new Error('injected')
      return fs.writeSync(...args)
    },
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
      if (failures.operation === 'fsync') throw new Error('injected')
      return fs.fsyncSync(...args)
    },
  }
})
const cleanupLog = vi.fn()
let directory: string
let now: number
let service: HostAttachments
let exists: boolean
const owner = { laneId: randomUUID(), clientId: randomUUID(), fence: 2 }
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const begin = (size = 3, name = 'report.pdf') =>
  ({ type: 'attachments.begin', name, size, mime: 'application/pdf' }) as const
async function start(size = 3, who = owner) {
  const result = await service.execute(who, begin(size))
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
const chunk = (uploadId: string, index = 0, data = 'abc') =>
  ({
    type: 'attachments.chunk',
    uploadId,
    index,
    data: Buffer.from(data).toString('base64'),
  }) as const
const commit = (uploadId: string, sha256 = hash('abc')) =>
  ({ type: 'attachments.commit', uploadId, sha256 }) as const
const temp = () => join(directory, 'attachments-tmp', owner.laneId)
function reopen() {
  service.close()
  service = createAttachments({
    directory,
    now: () => now,
    laneExists: () => exists,
    log: cleanupLog,
  })
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'host-attachments-')))
  cleanupLog.mockClear()
  now = 120000
  exists = true
  service = createAttachments({
    directory,
    now: () => now,
    laneExists: () => exists,
    log: cleanupLog,
  })
})
afterEach(() => {
  failures.operation = ''
  service.close()
  rmSync(directory, { recursive: true, force: true })
})
it('stores sanitized exclusive private files outside the repository and verifies disk bytes', async () => {
  const uploadId = await start()
  expect(lstatSync(temp()).mode & 0o777).toBe(0o700)
  expect(await service.execute(owner, chunk(uploadId))).toEqual({ ok: true })
  const result = await service.execute(owner, commit(uploadId))
  expect(result).toMatchObject({
    ok: true,
    data: { path: join(directory, 'attachments', owner.laneId, `${uploadId}-report.pdf`) },
  })
  const path = join(directory, 'attachments', owner.laneId, `${uploadId}-report.pdf`)
  expect(readFileSync(path, 'utf8')).toBe('abc')
  expect(lstatSync(path).mode & 0o777).toBe(0o600)
  expect(readdirSync(temp())).toEqual([])
  const second = await start()
  await service.execute(owner, chunk(second))
  writeFileSync(join(temp(), second), 'def')
  expect(await service.execute(owner, commit(second))).toEqual({ ok: false, code: 'bad-request' })
  const named = await service.execute(owner, begin(0, '../../evil name.pdf'))
  expect(named).toMatchObject({ ok: true })
  if (
    !named.ok ||
    typeof named.data !== 'object' ||
    named.data === null ||
    !('uploadId' in named.data) ||
    typeof named.data.uploadId !== 'string'
  )
    throw new Error('missing upload')
  expect(await service.execute(owner, commit(named.data.uploadId, hash('')))).toMatchObject({
    ok: true,
    data: {
      path: join(
        directory,
        'attachments',
        owner.laneId,
        `${named.data.uploadId}-.._.._evil_name.pdf`,
      ),
    },
  })
  const exclusive = await start()
  await service.execute(owner, chunk(exclusive))
  const existing = join(directory, 'attachments', owner.laneId, `${exclusive}-report.pdf`)
  writeFileSync(existing, 'do not replace')
  expect(await service.execute(owner, commit(exclusive))).toMatchObject({ ok: false })
  expect(readFileSync(existing, 'utf8')).toBe('do not replace')
  const changed = await start()
  writeFileSync(join(temp(), changed), 'changed')
  expect(await service.execute(owner, chunk(changed))).toMatchObject({ ok: false })
  const incomplete = await start(3)
  await service.execute(owner, chunk(incomplete, 0, 'a'))
  expect(await service.execute(owner, commit(incomplete, hash('a')))).toMatchObject({ ok: false })
  const empty = await start(0)
  expect(await service.execute(owner, commit(empty, hash('')))).toMatchObject({ ok: true })
})
it('refuses cross-client, lane and fence reuse without revealing existence', async () => {
  const uploadId = await start()
  for (const who of [
    { ...owner, clientId: randomUUID() },
    { ...owner, laneId: randomUUID() },
    { ...owner, fence: 3 },
  ]) {
    expect(await service.execute(who, chunk(uploadId))).toEqual({ ok: false, code: 'bad-request' })
    expect(await service.execute(who, commit(uploadId))).toEqual({ ok: false, code: 'bad-request' })
  }
  expect(await service.execute(owner, chunk(uploadId))).toEqual({ ok: true })
  service.abort(owner.laneId)
  expect(readdirSync(temp())).toEqual([])
  expect(await service.execute(owner, commit(uploadId))).toEqual({ ok: false, code: 'bad-request' })
})
it.each(['duplicate', 'gap', 'overflow', 'size', 'digest'] as const)(
  'aborts irreparably on %s',
  async (reason) => {
    const uploadId = await start()
    if (reason === 'duplicate') await service.execute(owner, chunk(uploadId))
    const result = await service.execute(
      owner,
      reason === 'size'
        ? commit(uploadId)
        : reason === 'digest'
          ? (await service.execute(owner, chunk(uploadId)), commit(uploadId, hash('wrong')))
          : chunk(uploadId, reason === 'gap' ? 1 : 0, reason === 'overflow' ? 'abcd' : 'abc'),
    )
    expect(result).toEqual({ ok: false, code: 'bad-request' })
    expect(readdirSync(temp())).toEqual([])
    expect(await service.execute(owner, chunk(uploadId))).toEqual({
      ok: false,
      code: 'bad-request',
    })
  },
)
it('enforces chunk and file limits, ten open uploads, expiry and removed lanes', async () => {
  expect(await service.execute(owner, begin(L.fileBytes + 1))).toMatchObject({ ok: false })
  const large = await start(L.fileBytes)
  expect(
    await service.execute(owner, {
      type: 'attachments.chunk',
      uploadId: large,
      index: 0,
      data: Buffer.alloc(L.chunkBytes).toString('base64'),
    }),
  ).toEqual({ ok: true })
  expect(
    await service.execute(owner, {
      type: 'attachments.chunk',
      uploadId: large,
      index: 1,
      data: Buffer.alloc(L.chunkBytes + 1).toString('base64'),
    }),
  ).toMatchObject({ ok: false })
  for (let i = 1; i < 10; i++) await start(0)
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
  now += L.lifetimeMs
  service.sweep()
  expect(readdirSync(temp())).toEqual([])
  await start(0)
  exists = false
  service.sweep()
  expect(readdirSync(join(directory, 'attachments'))).toEqual([])
  expect(await service.execute(owner, begin())).toMatchObject({ ok: false })
})
it('charges begun bytes even when abandoned, persists a conservative rolling hour and handles backwards clocks', async () => {
  for (let i = 0; i < 3; i++) {
    await start(L.fileBytes)
    service.abort(owner.laneId)
  }
  await start(4 * 1024 * 1024)
  service.abort(owner.laneId)
  reopen()
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
  now += 60 * 60000 + 59000
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
  now += 1000
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: true })
  service.abort(owner.laneId)
  for (let i = 0; i < 3; i++) {
    await start(L.fileBytes)
    service.abort(owner.laneId)
  }
  await start(4 * 1024 * 1024 - 65536)
  service.abort(owner.laneId)
  const forward = now
  now -= 5 * L.lifetimeMs
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
  now = forward + 60000
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
})
it('keeps new charges inside the same rolling hour when the clock moves backwards and forwards', async () => {
  now = 10 * L.lifetimeMs
  await start(L.fileBytes)
  service.abort(owner.laneId)
  now -= 5 * L.lifetimeMs
  await start(L.fileBytes)
  service.abort(owner.laneId)
  now = 10 * L.lifetimeMs + 60000
  await start(L.fileBytes)
  service.abort(owner.laneId)
  expect(await service.execute(owner, begin(L.fileBytes))).toMatchObject({ ok: false })
})

it('fails closed for corrupt, unsafe and missing ledgers beside existing files', async () => {
  await start(0)
  service.abort(owner.laneId)
  const path = join(directory, 'attachments', owner.laneId, '.quota')
  for (const data of ['not-json', '[]', JSON.stringify(Array(61).fill({ minute: 1, bytes: 0 }))]) {
    writeFileSync(path, data)
    expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
  }
  chmodSync(path, 0o644)
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
  chmodSync(path, 0o600)
  now += 61 * 60000
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: true })
  service.abort(owner.laneId)
  rmSync(path)
  writeFileSync(join(directory, 'attachments', owner.laneId, 'prior.pdf'), '')
  expect(await service.execute(owner, begin(0))).toMatchObject({ ok: false })
})
it('minimum reservation bounds small-file begins and cleanup never follows symlinks', async () => {
  const quota = join(directory, 'attachments', owner.laneId)
  await start(0)
  service.abort(owner.laneId)
  const ledger = join(quota, '.quota')
  const buckets: { minute: number; bytes: number }[] = JSON.parse(readFileSync(ledger, 'utf8'))
  expect(buckets.reduce((sum, b) => sum + b.bytes, 0)).toBe(65536)
  const outside = join(directory, 'outside')
  mkdirSync(outside)
  const victim = join(outside, 'keep')
  writeFileSync(victim, 'safe')
  const emptyTarget = join(outside, 'empty')
  writeFileSync(emptyTarget, '')
  const id = await start()
  rmSync(join(temp(), id))
  symlinkSync(emptyTarget, join(temp(), id))
  expect(await service.execute(owner, chunk(id))).toMatchObject({ ok: false })
  expect(readFileSync(emptyTarget, 'utf8')).toBe('')
  const linkCommit = await start(0)
  rmSync(join(temp(), linkCommit))
  symlinkSync(emptyTarget, join(temp(), linkCommit))
  expect(await service.execute(owner, commit(linkCommit, hash('')))).toMatchObject({ ok: false })
  service.remove(owner.laneId)
  service.remove(owner.laneId)
  expect(readFileSync(victim, 'utf8')).toBe('safe')
  symlinkSync(outside, join(directory, 'attachments', owner.laneId))
  expect(await service.execute(owner, begin())).toMatchObject({ ok: false })
  service.remove(owner.laneId)
  expect(readFileSync(victim, 'utf8')).toBe('safe')
  chmodSync(join(directory, 'attachments'), 0o755)
  expect(await service.execute(owner, begin())).toMatchObject({ ok: false })
})
it('sweeps expired orphan temporary files after restart and removes unknown lane directories', async () => {
  const id = await start()
  // A crashed process leaves no in-memory uploads.
  service.close()
  mkdirSync(temp(), { recursive: true })
  writeFileSync(join(temp(), id), 'partial')
  const orphan = randomUUID()
  mkdirSync(join(directory, 'attachments', orphan))
  service = createAttachments({
    directory,
    now: () => Date.now() + L.lifetimeMs + 1000,
    laneExists: (id) => id === owner.laneId,
  })
  expect(readdirSync(temp())).toEqual([])
  expect(readdirSync(join(directory, 'attachments'))).toEqual([owner.laneId])
})

it.each(['workspaces.write', 'sessions.control'] as const)(
  'receipt admission, queued %s, fencing, takeover and removal use the command service',
  async (lostCapability) => {
    const repo = join(directory, 'repo')
    mkdirSync(repo)
    const store = await openStore(join(directory, 'state'), process.getuid?.(), {
      onLaneRemoved: service.remove,
    })
    const repository = store.syncRepositories([repo])[0]
    if (!repository) throw new Error('repository missing')
    const lane = store.ensureLane({ repositoryId: repository.id, cwd: repo, sessionFile: null })
    const delivered: Receipt[] = []
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi.spyOn(service, 'execute')
    const commands = createLaneCommands({
      store,
      attachments: service,
      sessions: { start: vi.fn(), attach: vi.fn(), stop: vi.fn() },
      runtime: { command: vi.fn(), extensionUiResponse: vi.fn() },
      resumeLane: async () => blocked,
      stopLane: vi.fn(),
      sessionFor: () => null,
      openDialogs: () => [],
      summaryFor: () => null,
      publish: vi.fn(),
      deliver: (_id, receipt) => {
        delivered.push(receipt)
      },
      now: Date.now,
      log: vi.fn(),
    })
    let caps: readonly HostCapability[] = ['sessions.control', 'workspaces.write']
    const client: LaneCommandClient = {
      id: owner.clientId,
      label: 'Desktop',
      caps,
      currentCaps: () => caps,
    }
    const frame = (
      op: LaneCommandFrame['op'],
      fence = store.getLane(lane.laneId)?.control.fence,
    ): LaneCommandFrame => ({
      type: 'command',
      requestId: randomUUID(),
      laneId: lane.laneId,
      fence,
      op,
    })
    try {
      expect(commands.capabilityFor(begin())).toEqual(['workspaces.write', 'sessions.control'])
      for (const missing of ['workspaces.write', 'sessions.control']) {
        caps = client.caps.filter((cap) => cap !== missing)
        const denied = frame(begin())
        await commands.submit({ ...client, caps }, denied)
        expect(delivered.at(-1)).toMatchObject({ status: 'rejected', code: 'forbidden' })
      }
      caps = client.caps
      const first = frame(begin())
      await commands.submit(client, first)
      const done = delivered.at(-1)
      expect(done).toMatchObject({ status: 'done' })
      expect(execute).toHaveBeenCalledTimes(1)
      await commands.submit(client, first)
      expect(execute).toHaveBeenCalledTimes(1)
      const data = done?.status === 'done' ? done.data : null
      if (
        typeof data !== 'object' ||
        !data ||
        !('uploadId' in data) ||
        typeof data.uploadId !== 'string'
      )
        throw new Error('upload missing')
      await commands.submit(client, frame(chunk(data.uploadId), 1))
      expect(delivered.at(-1)).toMatchObject({ status: 'rejected', code: 'stale-fence' })
      await commands.submit({ ...client, id: randomUUID() }, frame(chunk(data.uploadId)))
      expect(delivered.at(-1)).toMatchObject({ status: 'rejected', code: 'not-controller' })
      await commands.submit(client, frame({ type: 'control.take' }))
      expect(
        await service.execute({ ...owner, laneId: lane.laneId }, chunk(data.uploadId)),
      ).toMatchObject({ ok: false })
      const waiting = commands.submit(client, frame({ type: 'lane.resume' }))
      const queued = commands.submit(client, frame(begin()))
      caps = client.caps.filter((cap) => cap !== lostCapability)
      release()
      await waiting
      await queued
      expect(delivered.at(-1)).toMatchObject({ status: 'rejected', code: 'forbidden' })
      caps = client.caps
      const uncertain = frame(begin())
      let finishUpload: () => void = () => {}
      const operation = new Promise<{ ok: false; code: 'bad-request' }>((resolve) => {
        finishUpload = () => resolve({ ok: false, code: 'bad-request' })
      })
      execute.mockImplementationOnce(() => {
        expect(store.getReceipt(uncertain.requestId, client.id)?.status).toBe('pending')
        return operation
      })
      vi.useFakeTimers()
      const pending = commands.submit(client, uncertain)
      await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs + 1)
      await pending
      expect(delivered.at(-1)).toMatchObject({ status: 'unknown' })
      const calls = execute.mock.calls.length
      await commands.submit(client, uncertain)
      expect(delivered.at(-1)).toMatchObject({ status: 'unknown' })
      expect(execute).toHaveBeenCalledTimes(calls)
      finishUpload()
      await Promise.resolve()
      vi.useRealTimers()
      await commands.submit(client, frame(begin()))
      store.markRemoved(lane.laneId)
      expect(readdirSync(join(directory, 'attachments-tmp'))).not.toContain(lane.laneId)
    } finally {
      vi.useRealTimers()
      release()
      await commands.close()
      store.close()
    }
  },
)

it('fails closed on a readable valid ledger with unsafe permissions', async () => {
  await start(0)
  service.abort(owner.laneId)
  const path = join(directory, 'attachments', owner.laneId, '.quota')
  chmodSync(path, 0o644)
  expect(await service.execute(owner, begin(0))).toEqual({ ok: false, code: 'bad-request' })
})

it('fails closed on a symlink to an otherwise valid private ledger', async () => {
  await start(0)
  service.abort(owner.laneId)
  const path = join(directory, 'attachments', owner.laneId, '.quota')
  const target = join(directory, 'outside-quota')
  writeFileSync(target, readFileSync(path), { mode: 0o600 })
  rmSync(path)
  symlinkSync(target, path)
  expect(await service.execute(owner, begin(0))).toEqual({ ok: false, code: 'bad-request' })
})

it.each(['write', 'fsync'])(
  'removes quota temp files after %s failure and refuses admission',
  async (operation) => {
    failures.operation = operation
    expect(await service.execute(owner, begin())).toEqual({ ok: false, code: 'bad-request' })
    expect(readdirSync(join(directory, 'attachments', owner.laneId))).toEqual([])
    failures.operation = ''
    expect(await service.execute(owner, begin())).toEqual({ ok: false, code: 'bad-request' })
  },
)
it.each(['lane', 'root'])('refuses discard through a swapped %s ancestor', async (ancestor) => {
  const id = await start()
  const outside = join(directory, 'outside')
  mkdirSync(outside)
  if (ancestor === 'root') mkdirSync(join(outside, owner.laneId))
  const outsideFile = join(outside, ...(ancestor === 'root' ? [owner.laneId] : []), id)
  writeFileSync(outsideFile, 'keep')
  const parent = ancestor === 'root' ? join(directory, 'attachments-tmp') : temp()
  rmSync(parent, { recursive: true })
  symlinkSync(outside, parent)
  service.abort(owner.laneId)
  expect(readFileSync(outsideFile, 'utf8')).toBe('keep')
  expect(cleanupLog).toHaveBeenCalledExactlyOnceWith('attachments.cleanup-refused')
})
