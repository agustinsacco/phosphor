import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENT_POLICY_DEFAULT } from '@phosphor/shared/ops'
import type { LaneSummary } from '@phosphor/shared/host-protocol'
import { openStore, type HostStore } from '../lanes/store'
import { createOpsService, type OpsService } from './service'

const uid = process.getuid?.()
const MACHINE = '00000000-0000-4000-8000-000000000001'
const lane: LaneSummary = {
  laneId: 'lane-1',
  repositoryId: 'repo',
  cwd: '/tmp/repo',
  title: 'Lane one',
  branch: null,
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
}
const owner = {
  kind: 'surface',
  clientId: 'owner-client',
  label: 'Desktop',
  via: 'owner',
  caps: ['sessions.read', 'sessions.control', 'machine.configure'],
} as const

let directory: string
let store: HostStore
let service: OpsService

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'host-ops-guard-'))
  store = await openStore(join(directory, 'state'), uid, {})
  service = await createOpsService({
    stateDirectory: join(directory, 'state'),
    uid,
    selfIds: () => [MACHINE],
    enrolledId: () => MACHINE,
    store,
    lanes: {} as never,
    shellEnvironment: null,
    daemonLanes: {
      list: () => [lane],
      summary: (id) => (id === lane.laneId ? lane : null),
      sessionFor: (id) => (id === lane.laneId ? 'session-1' : null),
    },
    command: async () => ({ success: true }),
    unattended: () => false,
    log: () => {},
  })
})

afterEach(() => {
  service.close()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

/** An agent's asked op whose dialog the lane opened: bound to its pending confirmation. */
async function boundConfirm() {
  const policy = { ...AGENT_POLICY_DEFAULT, ops: { whoami: 'ask' as const } }
  const set = await service.dispatcher.run(owner, { op: 'policy.set', args: { policy } })
  expect(set.status).toBe('ok')
  const reply = await service.dispatcher.runFromTool('session-1', {
    v: 1,
    id: 'request-1',
    op: 'whoami',
    input: {},
    reason: 'Check who I am.',
    deadlineMs: 5000,
  })
  if (reply.status !== 'confirm')
    throw new Error(`expected a confirm, got ${JSON.stringify(reply)}`)
  service.dispatcher.confirmSeen('session-1', {
    id: 'dialog-1',
    title: reply.title,
    message: reply.message,
  })
}

it('refuses a non-surface answer to a bound op confirm on answerDialog', async () => {
  await boundConfirm()
  const answer = { type: 'extension_ui_response', id: 'dialog-1', confirmed: true } as const
  expect(service.dialogGuard(lane.laneId, answer, { origin: 'machine' })).toBe('forbidden')
  expect(service.dialogGuard(lane.laneId, answer, { origin: 'local' })).toBe('forbidden')
  expect(service.dialogGuard(lane.laneId, answer, {})).toBe('relay')
})

it('relays an ordinary dialog answer from any origin', () => {
  const answer = { type: 'extension_ui_response', id: 'other', confirmed: true } as const
  expect(service.dialogGuard(lane.laneId, answer, { origin: 'machine' })).toBe('relay')
  expect(service.dialogGuard('no-such-lane', answer, { origin: 'machine' })).toBe('relay')
})

it.each(['lane.stop', 'lane.archive', 'lane.delete'])(
  'asks about the named controller before %s of a bare lane id',
  async (op) => {
    const controller = { clientId: 'other', label: 'My phone', connected: true }
    const previous = lane.control.controller
    Object.assign(lane.control, { controller })
    try {
      const request = { op, args: { ref: lane.laneId }, reason: 'tidy up' }
      const result = await service.dispatcher.run({ kind: 'local', clientId: 'cli' }, request)
      expect(result).toMatchObject({
        status: 'confirm',
        message: expect.stringContaining('controlled by My phone'),
      })
      Object.assign(lane, { activity: 'working' })
      expect(
        await service.dispatcher.run({ kind: 'local', clientId: 'cli' }, request),
      ).toMatchObject({ status: 'denied', code: 'busy' })
    } finally {
      Object.assign(lane, { activity: 'idle' })
      Object.assign(lane.control, { controller: previous })
    }
  },
)

it('starts a catalog download as a job without terminating the asking lane for an early reload', async () => {
  const reply = await service.dispatcher.runFromTool('session-1', {
    v: 1,
    id: 'install',
    op: 'skill.install',
    input: { scope: 'user', name: 'demo', libraryId: 'not-a-reviewed-library' },
    reason: 'Install a skill.',
    deadlineMs: 5000,
  })
  expect(reply).toMatchObject({
    status: 'ok',
    applies: 'new-lanes',
    text: expect.stringMatching(/^Started:/),
  })
  expect(reply).not.toHaveProperty('terminate', true)
})
