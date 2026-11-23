import { afterEach, beforeAll, expect, it, vi, type Mock } from 'vitest'
const main = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: main }))
vi.mock('./sender-policy', () => ({ admitSender: () => undefined }))
import type { IpcInvokeChannel } from '@shared/ipc'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import { IN_APP_RUNTIME_REFUSED, decideLocalRuntimeMode } from '../local-machine/mode'
import { bindSameMachine } from '../local-machine/same-machine'
import { fakeLocalService } from '../local-machine/__fixtures__/local-service'
import { handle, setRemoteReadRouter } from './handle'

/** `handle()` once the launch gate chose daemon mode: `LOCAL_ROUTE` decides each call. */

const SENDER = { sender: { id: 1 } }
const REPO_ID = '0123456789abcdef'
const LANE = 'host:mac-0001/lane:lane-1'
const REPO = `host:mac-0001/repo:${REPO_ID}`
const CWD = '/Users/u/repo/.phosphor/worktrees/a'
const fake = fakeLocalService('mac-0001')
fake.repositories = [{ id: REPO_ID, path: '/Users/u/repo' }]
fake.lanes = [{ laneId: 'lane-1', cwd: CWD, activity: 'idle' }]

beforeAll(() => {
  decideLocalRuntimeMode('daemon', {
    location: { kind: 'dev', socket: '/tmp/m2b/s.sock', configDir: '/tmp/m2b/config' },
    ownerKey: () => Promise.reject(new Error('unused')),
  })
})
afterEach(() => {
  fake.state = 'ready'
  bindSameMachine({ hostId: fake.hostId, connection: () => fake.connection })
  setRemoteReadRouter(() => null)
})
bindSameMachine({ hostId: fake.hostId, connection: () => fake.connection })

function registered(channel: IpcInvokeChannel, local: Mock) {
  handle(channel, local)
  const wrapped: unknown = main.handle.mock.calls.at(-1)?.[1]
  if (typeof wrapped !== 'function') throw new Error('Missing handler')
  return (...args: unknown[]): unknown => wrapped(SENDER, ...args)
}
function failure(call: () => unknown): string | undefined {
  try {
    call()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

it('runs a same-machine handler on the real path of this machine’s lane or folder', async () => {
  const local = vi.fn(async () => 'ran')
  expect(await registered('fs:readDir', local)(LANE, `${LANE}/src`)).toBe('ran')
  expect(local).toHaveBeenLastCalledWith(SENDER, CWD, `${CWD}/src`)
  await registered('git:statusMap', local)(REPO)
  expect(local).toHaveBeenLastCalledWith(SENDER, '/Users/u/repo')
  await registered('git:removeWorktree', local)(REPO, LANE, { force: false })
  expect(local).toHaveBeenLastCalledWith(SENDER, '/Users/u/repo', CWD, { force: false })
})

it('resolves before the remote router, which keeps serving every other Host', async () => {
  const router = vi.fn((_w: number, _c: IpcInvokeChannel, args: unknown[]) =>
    String(args[0]).startsWith('host:other/') ? { result: Promise.resolve('remote') } : null,
  )
  setRemoteReadRouter(router)
  const local = vi.fn(() => 'local')
  const read = registered('fs:readFile', local)
  expect(read(`${LANE}/a.ts`)).toBe('local')
  expect(router).not.toHaveBeenCalled()
  expect(await read('host:other/lane:x/a.ts')).toBe('remote')
  expect(local).toHaveBeenCalledOnce()
})

it('keeps today’s refusal for any other Host id, and for unresolvable keys of this one', () => {
  const local = vi.fn()
  const read = registered('fs:readFile', local)
  for (const key of [
    'host:other/lane:lane-1/a',
    'host:mac-0001/lane:lane-2/a',
    `${LANE}/../a`,
    `${LANE}/${'a'.repeat(4096)}`,
  ])
    expect([key, failure(() => read(key))]).toEqual([key, REMOTE_UNAVAILABLE])
  expect(failure(() => read(42))).toBe(REMOTE_UNAVAILABLE)
  // A mix of this machine and another Host is refused, never half-resolved.
  expect(failure(() => registered('fs:rename', local)(`${LANE}/a`, 'host:other/lane:x/b'))).toBe(
    REMOTE_UNAVAILABLE,
  )
  expect(local).not.toHaveBeenCalled()
})

it('refuses this machine’s keys while its connection is not ready or its slot is gone', () => {
  const local = vi.fn()
  const read = registered('fs:readFile', local)
  fake.state = 'reconnecting'
  expect(failure(() => read(`${LANE}/a`))).toBe(REMOTE_UNAVAILABLE)
  bindSameMachine(null)
  expect(failure(() => read(`${LANE}/a`))).toBe(REMOTE_UNAVAILABLE)
  expect(local).not.toHaveBeenCalled()
})

it('fails closed for in-app-only handlers, even on a local path', () => {
  const local = vi.fn()
  for (const [channel, args] of [
    ['pi:createSession', [{ workspacePath: '/Users/u/repo' }]],
    ['sessions:forkAt', ['/Users/u/s.jsonl', 'entry']],
    ['pty:create', ['/Users/u/repo', 80, 24]],
    ['routines:run', ['routine-1']],
    ['skills:writeFile', ['/skills/a', 'SKILL.md', 'x']],
  ] as const)
    expect([channel, failure(() => registered(channel, local)(...args))]).toEqual([
      channel,
      IN_APP_RUNTIME_REFUSED,
    ])
  expect(failure(() => registered('pi:createSession', local)({ workspacePath: LANE }))).toBe(
    REMOTE_UNAVAILABLE,
  )
  expect(local).not.toHaveBeenCalled()
})

it('lets the remote router serve an in-app-only channel’s Host keys first', async () => {
  setRemoteReadRouter((_w, channel, args) =>
    channel === 'skills:list' && String(args[0]).startsWith('host:')
      ? { result: Promise.resolve('host skills') }
      : null,
  )
  const local = vi.fn()
  expect(await registered('skills:list', local)(`${LANE}`)).toBe('host skills')
  expect(local).not.toHaveBeenCalled()
})

it('runs host, app and local same-machine calls unchanged', async () => {
  const local = vi.fn(async () => 'ran')
  expect(await registered('hosts:models', local)('mac-0001')).toBe('ran')
  expect(await registered('app:selectFolder', local)()).toBe('ran')
  expect(await registered('app:recordWorkspace', local)('/Users/u/repo')).toBe('ran')
  expect(await registered('fs:readFile', local)('/Users/u/repo/a.ts')).toBe('ran')
  expect(local).toHaveBeenLastCalledWith(SENDER, '/Users/u/repo/a.ts')
})
