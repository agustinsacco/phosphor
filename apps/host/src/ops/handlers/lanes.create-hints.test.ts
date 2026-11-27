import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createCommandsFixture,
  type CommandsFixture,
} from '../../lanes/__fixtures__/commands.fixture'
import { createOpsService, type OpsService } from '../service'
import type { LaneService } from '../../lanes/service'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { JOB_HOST_HINT } from '@phosphor/session-runtime/ops/job-explain'
import { MODEL_HINT } from './lane-folder'

let f: CommandsFixture
let service: OpsService
const cli = { kind: 'local', clientId: 'cli' } as const

beforeEach(async () => {
  f = await createCommandsFixture()
  vi.mocked(f.ports.sessions.attach).mockImplementation(async (id, session) => {
    f.sessions.set(id, session)
  })
  f.command.mockResolvedValue(f.success)
  service = await createOpsService({
    stateDirectory: join(f.root, 'state'),
    uid: process.getuid?.(),
    enrolledId: () => null,
    selfIds: () => [],
    store: f.store,
    editing: {} as never,
    lanes: { commands: f.service, calls: {} } as unknown as LaneService,
    shellEnvironment: null,
    log: f.ports.log,
    command: f.command,
    unattended: () => false,
    daemonLanes: {
      list: () => f.store.listLanes(),
      summary: (id) => f.store.getLane(id),
      sessionFor: f.ports.sessionFor,
    },
  })
})
afterEach(() => {
  service.close()
  f.cleanup()
  vi.restoreAllMocks()
})

function ok(r: OpsRunResult) {
  if (r.status !== 'ok') throw Error(JSON.stringify(r))
  return r
}
async function create(args: Record<string, unknown>) {
  const started = ok(await service.dispatcher.run(cli, { op: 'lane.create', args }))
  const { jobId } = started.data as { jobId: string }
  const status = async () =>
    ok(await service.dispatcher.run(cli, { op: 'job.status', args: { jobId } }))
  await vi.waitFor(async () =>
    expect((await status()).data).not.toMatchObject({ state: 'running' }),
  )
  return { started, status: await status() }
}
const repo = () => f.store.listRepositories().find((r) => r.id === f.lane.repositoryId)!

it('creates in a folder named by its folder-list name', async () => {
  const { started, status } = await create({ folder: repo().name })
  // The summary's usage notes stay in help, out of the Started line.
  expect(started.text).toBe(
    `Started: Start a lane, optionally with an initial prompt. Check it with: phosphor job status ${(started.data as { jobId: string }).jobId}`,
  )
  expect(status.data).toMatchObject({ state: 'done' })
  expect(status.text).toContain('Created ')
})

it('names the registered folders, not --fresh, when the folder is unknown', async () => {
  const { status } = await create({ folder: 'no-such-folder' })
  expect(status.data).toMatchObject({ state: 'failed' })
  expect(status.text).toContain('No registered folder matches no-such-folder.')
  expect(status.text).toContain(`${repo().name} (${repo().path})`)
  expect(status.text).not.toContain('--fresh')
})

it('refuses --fresh without a worktree on its own', async () => {
  const { status } = await create({ folder: repo().id, fresh: true })
  expect(status.text).toContain('--fresh needs --worktree <branch>.')
})

it('says to add a provider when a bare model ID fails to start', async () => {
  vi.mocked(f.ports.sessions.start).mockRejectedValueOnce(new Error('unknown model'))
  const { status } = await create({ folder: repo().id, model: 'claude-opus-5-5' })
  expect(status.data).toMatchObject({ state: 'failed' })
  expect(status.text).toContain(MODEL_HINT)
})

it('keeps a provider-qualified start failure free of the model hint', async () => {
  vi.mocked(f.ports.sessions.start).mockRejectedValueOnce(new Error('unknown model'))
  const { status } = await create({ folder: repo().id, model: 'pi-claude-cli/claude-opus-5-5' })
  expect(status.data).toMatchObject({ state: 'failed' })
  expect(status.text).not.toContain(MODEL_HINT)
})

it('lists lanes by folder name', async () => {
  const listed = ok(
    await service.dispatcher.run(cli, { op: 'lane.list', args: { folder: repo().name } }),
  )
  expect((listed.data as { lanes: { laneId: string }[] }).lanes.map((l) => l.laneId)).toContain(
    f.lane.laneId,
  )
})

it('tells the caller where a job lives when it is not here', async () => {
  const r = await service.dispatcher.run(cli, { op: 'job.status', args: { jobId: 'missing' } })
  expect(r).toMatchObject({ status: 'denied', text: expect.stringContaining(JOB_HOST_HINT) })
})
