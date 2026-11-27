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
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import type { AgentOpRow } from '@phosphor/shared/ops'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { OpPrincipal, OpsBinding } from '@phosphor/session-runtime/ops/types'
import { OP_MARKER_ENV, OP_MARKER_VALUE, parseOpChannelRequest } from '@phosphor/shared/ops'
import phosphor from '@phosphor/pi-extensions/phosphor'

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
const hosts = ['bee1', 'bee2']
const remoteRun = vi.fn<NonNullable<OpsBinding['remote']>['run']>()
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
    directory: async () => ({
      available: true,
      self: { id: 'local', label: 'Local' },
      machines: hosts.map((id) => ({
        id,
        label: id,
        online: true,
        ready: true,
        hostVersion: null,
      })),
    }),
    remote: { run: remoteRun },
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
      list: () =>
        f.store
          .listLanes()
          .map((l) => (l.laneId === f.lane.laneId ? { ...l, activity: 'working' } : l)),
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
  remoteRun.mockReset()
  vi.unstubAllEnvs()
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

it('offers recovery advice on an oversized lane.read messages refusal', async () => {
  read.mockResolvedValueOnce({
    ok: false,
    error: { code: 'too-large', message: 'the lane query could not complete' },
  })
  const result = await service.dispatcher.run(cli, {
    op: 'lane.read',
    args: { ref: f.lane.laneId, part: 'messages' },
  })
  expect(result).toMatchObject({
    status: 'denied',
    code: 'too-large',
    text: expect.stringMatching(/summary/),
  })
})

it('shows live lanes with reusable canonical refs', async () => {
  const lane = f.store.getLane(f.lane.laneId)!
  const result = ok(await service.dispatcher.run(cli, { op: 'lane.list', args: { state: 'live' } }))
  expect(result.data).toMatchObject({ lanes: [{ ref: `host:local/lane:${lane.laneId}` }] })
})

it('advertises the activity enum and rejects unknown lane state filters', async () => {
  for (const op of ['lane.list', 'lane.search']) {
    expect(OP_CATALOG.find((spec) => spec.name === op)?.args.properties.state).toMatchObject({
      enum: ['stopped', 'idle', 'working', 'needs-input', 'failed', 'live'],
    })
    const result = await service.dispatcher.runFromTool('pi-live', {
      v: 1,
      id: 'test',
      argv: [...op.split('.'), ...(op === 'lane.search' ? ['test'] : []), '--state', 'busy'],
      deadlineMs: 1000,
    })
    expect(result).toMatchObject({
      status: 'denied',
      code: 'bad-request',
      text: expect.stringContaining(
        'state: expected one of stopped|idle|working|needs-input|failed|live.',
      ),
    })
  }
})

function connectAgentTool() {
  vi.stubEnv(OP_MARKER_ENV, OP_MARKER_VALUE)
  type Tool = Parameters<Parameters<typeof phosphor>[0]['registerTool']>[0]
  let tool!: Tool
  phosphor({
    appendEntry: vi.fn(),
    registerTool: (registered) => {
      tool = registered
    },
  })
  const dispatch = vi.fn(async (prefill: string) => {
    const request = parseOpChannelRequest(prefill)
    if (!request || !('argv' in request)) throw new Error('Expected an argv tool request')
    return service.dispatcher.runFromTool('pi-live', request)
  })
  const ctx = {
    sessionManager: { getSessionId: () => 'pi-live' },
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(async () => false),
      editor: async (_title: string, prefill: string) => JSON.stringify(await dispatch(prefill)),
    },
  }
  const run = (args: string[]) => tool.execute('call', { args }, undefined, undefined, ctx)
  return { run, dispatch }
}

it('threads an agent page limit through the dispatcher and renders local and per-host continuations', async () => {
  for (const title of ['Second lane', 'Third lane']) {
    f.store.ensureLane({
      repositoryId: f.lane.repositoryId,
      cwd: f.lane.cwd,
      sessionFile: join(f.root, `${title}.jsonl`),
      title,
    })
  }
  const { run, dispatch } = connectAgentTool()
  const args = ['lane', 'list', '--limit', '2']
  const first = await run(args)
  expect(await dispatch.mock.results[0]!.value).toMatchObject({
    status: 'ok',
    op: 'lane.list',
    read: true,
    next: '2',
    data: { lanes: [expect.any(Object), expect.any(Object)] },
  })
  const firstText = first.content[0]!.text
  expect(firstText).toMatch(
    /^<phosphor-data [^\n]+>\nref \| title \| state \| branch \| updated\nhost:local\/lane:[^\n]+\nhost:local\/lane:[^\n]+\n<\/phosphor-data>\nMore: phosphor lane list --limit 2 --page 2$/,
  )

  remoteRun.mockImplementation(async (host) => ({
    status: 'ok',
    applies: 'now',
    text: `Rows from ${host}`,
    next: `cursor_${host}`,
  }))
  const batch = await run([...args, '--host', 'all'])
  const reply = await dispatch.mock.results[1]!.value
  expect(reply).toMatchObject({
    status: 'ok',
    read: true,
    data: {
      summary: { total: 2, ok: 2, failed: 0 },
      hosts: hosts.map((hostId) => ({ hostId, next: `cursor_${hostId}` })),
    },
  })
  expect(reply).not.toHaveProperty('next')
  expect(
    remoteRun.mock.calls.map(([hostId, request]) => [hostId, request.op, request.limit]),
  ).toEqual(hosts.map((hostId) => [hostId, 'lane.list', 2]))
  const batchText = batch.content[0]!.text
  for (const host of hosts) {
    expect(batchText).toContain(`Continue: --host "${host}" --page "cursor_${host}"`)
  }
  expect(batchText).not.toContain('More:')
})

it('renders the producing command for a job page and follows it through the tool', async () => {
  read.mockResolvedValue({
    ok: true,
    data: { resources: { packages: [{ spec: 'npm:first' }, { spec: 'npm:second' }] } },
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ version: '2.0.0' }))
  const { run, dispatch } = connectAgentTool()
  async function completedPage(args: string[]) {
    const started = await run(args)
    expect(started.details.status).toBe('ok')
    const jobId = /phosphor job status (\S+)/.exec(started.content[0]!.text)?.[1]
    expect(jobId).toBeTruthy()
    return vi.waitFor(async () => {
      const status = await run(['job', 'status', jobId!])
      expect(status.content[0]!.text).toContain(`Job ${jobId}: done.`)
      const reply = await dispatch.mock.results.at(-1)!.value
      return { text: status.content[0]!.text, reply }
    })
  }

  const first = await completedPage(['package', 'check-updates', '--limit', '1'])
  expect(first.reply).not.toHaveProperty('next')
  expect(first.reply).toMatchObject({
    data: { op: 'package.checkUpdates', result: { next: '1', data: { 'npm:first': '2.0.0' } } },
  })
  expect(first.text).not.toContain('More: phosphor job status')
  const hint = /^More: phosphor (.+)$/m.exec(first.text)?.[1]
  expect(hint).toBe('package check-updates --page 1')

  const second = await completedPage(hint!.split(' '))
  expect(second.reply).toMatchObject({
    data: { op: 'package.checkUpdates', result: { data: { 'npm:second': '2.0.0' } } },
  })
  expect(second.text).not.toContain('npm:first')
  expect(second.text).not.toContain('More:')
})
