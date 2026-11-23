import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createCommandsFixture,
  deferred,
  type CommandsFixture,
} from '../../lanes/__fixtures__/commands.fixture'
import { createOpsService, type OpsService } from '../service'
import type { LaneService } from '../../lanes/service'
import type { LaneArchiveEntry } from '@phosphor/shared/lane-archive'
import type { AgentOpRow } from '@phosphor/shared/ops'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { OpPrincipal } from '@phosphor/session-runtime/ops/types'

let f: CommandsFixture
let service: OpsService
const cli = { kind: 'local', clientId: 'cli' } as const
const owner = {
  kind: 'surface',
  clientId: randomUUID(),
  via: 'owner',
  label: 'Desktop',
  caps: ['sessions.read', 'sessions.control', 'workspaces.write', 'machine.configure'],
} as const
let entries: LaneArchiveEntry[]
const archive = vi.fn(async () => ({ ok: true as const }))
const read = vi.fn<LaneService['calls']['call']>()
beforeEach(async () => {
  entries = []
  f = await createCommandsFixture()
  vi.mocked(f.ports.sessions.attach).mockImplementation(async (id, session) => {
    f.sessions.set(id, session)
  })
  f.command.mockResolvedValue(f.success)
  read.mockImplementation(async () => ({
    ok: true,
    data: { entries, bytes: null, measuredAt: null, measuring: false, truncated: false },
  }))
  service = await createOpsService({
    stateDirectory: join(f.root, 'state'),
    uid: process.getuid?.(),
    enrolledId: () => null,
    selfIds: () => [],
    store: f.store,
    editing: {} as never,
    lanes: {
      commands: f.service,
      calls: {
        call: read,
        capabilityFor: (method: string) =>
          method === 'artifacts.list'
            ? 'artifacts.read'
            : method === 'lane.exportHtml'
              ? 'sessions.control'
              : 'sessions.read',
      },
    } as unknown as LaneService,
    shellEnvironment: null,
    log: f.ports.log,
    command: f.command,
    unattended: () => false,
    daemonLanes: {
      list: () => f.store.listLanes(),
      summary: (id) => f.store.getLane(id),
      sessionFor: f.ports.sessionFor,
    },
    management: {
      stopLane: f.ports.stopLane,
      resumeLane: f.ports.resumeLane,
      admitsResume: () => true,
      archives: { execute: archive },
    },
  })
})
afterEach(() => {
  service.close()
  f.cleanup()
  vi.restoreAllMocks()
  archive.mockClear()
  read.mockReset()
})
async function rows() {
  const r = await service.dispatcher.run(owner, { op: 'audit.list', args: {} })
  if (r.status !== 'ok') throw Error(JSON.stringify(r))
  return r.data as AgentOpRow[]
}
function ok(r: OpsRunResult) {
  if (r.status !== 'ok') throw Error(JSON.stringify(r))
  return r
}
async function jobState(started: ReturnType<typeof ok>, p: OpPrincipal = cli) {
  const { jobId } = started.data as { jobId: string }
  expect(jobId).toBeTruthy()
  return ok(await service.dispatcher.run(p, { op: 'job.status', args: { jobId } })).data as {
    state: string
    result: { text: string; data?: { laneId: string } } | null
  }
}
it('starts a real queued creation, prompts only its new lane, and attaches Undo only at job success', async () => {
  const prompt = deferred<typeof f.success>()
  f.command.mockReturnValueOnce(prompt.promise)
  const started = ok(
    await service.dispatcher.run(cli, {
      op: 'lane.create',
      args: { folder: f.lane.repositoryId, prompt: 'say hello', name: 'Child' },
    }),
  )
  expect(started.text).toContain('Started')
  expect((await rows()).find((r) => r.id === started.auditId)).toMatchObject({ undo: false })
  await vi.waitFor(() =>
    expect(f.command).toHaveBeenCalledWith(
      'new-session',
      expect.objectContaining({ type: 'prompt', message: 'say hello' }),
    ),
  )
  prompt.release(f.success)
  await vi.waitFor(async () => expect(await jobState(started)).toMatchObject({ state: 'done' }))
  const job = await jobState(started)
  const id = job.result!.data!.laneId
  expect(id).not.toBe(f.lane.laneId)
  expect(f.store.getLane(id)?.control.controller).toBeNull()
  const changes = (await rows()).filter((r) => r.op === 'lane.create')
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ id: started.auditId, undo: true })
  f.store.updateLane(id, { title: 'Another change' })
  expect(await service.dispatcher.undo(owner, started.auditId!)).toMatchObject({
    code: 'unavailable',
    text: expect.stringContaining('changed again'),
  })
  expect(archive).not.toHaveBeenCalled()
})
it('does not attach an inverse to a failed lane creation', async () => {
  vi.mocked(f.ports.sessions.start).mockRejectedValueOnce(new Error('refused'))
  const started = ok(
    await service.dispatcher.run(cli, { op: 'lane.create', args: { folder: f.lane.repositoryId } }),
  )
  await vi.waitFor(async () => expect(await jobState(started)).toMatchObject({ state: 'failed' }))
  expect((await rows()).filter((r) => r.op === 'lane.create')).toMatchObject([
    { id: started.auditId, undo: false },
  ])
})
it('self stop waits for settle, then can undo the successful stop', async () => {
  const { dispatcher } = service
  const result = await dispatcher.runFromTool('pi-live', {
    v: 1,
    id: 'test',
    op: 'lane.stop',
    input: { ref: f.lane.laneId },
    reason: 'finished',
    deadlineMs: 1000,
  })
  expect(result.status).toBe('ok')
  expect(f.ports.stopLane).not.toHaveBeenCalled()
  expect((await rows())[0]).toMatchObject({ op: 'lane.stop', undo: false })
  await dispatcher.settled('pi-live', {})
  expect(f.ports.stopLane).toHaveBeenCalledTimes(1)
  const [changed] = await rows()
  expect(changed).toMatchObject({ op: 'lane.stop', undo: true })
  expect(await dispatcher.undo(owner, changed!.id)).toMatchObject({ status: 'ok' })
  expect(f.ports.resumeLane).toHaveBeenCalledTimes(1)
})
it('expands purge --all before authorization, rejects inventory growth at redemption', async () => {
  const entry = (): LaneArchiveEntry => ({
    id: randomUUID(),
    title: 'Archive',
    cwd: f.root,
    state: 'archived',
    archivedAt: 0,
  })
  entries = [entry(), entry()]
  const request = { op: 'archive.purge', args: { all: true } }
  const asked = await service.dispatcher.run(cli, request)
  expect(asked).toMatchObject({
    status: 'confirm',
    items: [{ ids: entries.map((e) => e.id).sort() }],
  })
  if (asked.status !== 'confirm') throw Error('missing confirm')
  const { confirmId, digest } = asked
  ok(await service.dispatcher.run(owner, { op: 'confirm.approve', args: { confirmId } }))
  entries.push(entry())
  expect(
    await service.dispatcher.run(cli, { ...request, confirm: { confirmId, digest } }),
  ).toMatchObject({ code: 'confirm-mismatch' })
  expect(archive).not.toHaveBeenCalled()
})
it.each([
  ['lane.export', {}],
  ['lane.read', { part: 'artifacts' }],
] as const)('does not grant a sessions.read surface the stronger %s call', async (op, args) => {
  const reader = { ...owner, caps: ['sessions.read'] }
  expect(
    await service.dispatcher.run(reader, { op, args: { ref: f.lane.laneId, ...args } }),
  ).toMatchObject({ code: 'forbidden' })
  expect(read).not.toHaveBeenCalled()
})
