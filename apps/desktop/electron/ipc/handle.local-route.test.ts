import { expect, it, vi, type Mock } from 'vitest'
const main = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: main }))
vi.mock('./sender-policy', () => ({ admitSender: () => undefined }))
import type { IpcInvokeChannel } from '@shared/ipc'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import { handle } from './handle'

/**
 * How `handle()` treats This Mac's own Host keys while Desktop runs its lanes
 * in-app (no launch-gate decision). The daemon-mode routing must leave all of
 * this unchanged.
 */

const SENDER = { sender: { id: 1 } }
const LANE = 'host:mac-1/lane:lane-1'
const REPO = 'host:mac-1/repo:0123456789abcdef'

function registered(channel: IpcInvokeChannel, local: Mock) {
  handle(channel, local)
  const wrapped: unknown = main.handle.mock.calls.at(-1)?.[1]
  if (typeof wrapped !== 'function') throw new Error('Missing handler')
  return (...args: unknown[]): unknown => wrapped(SENDER, ...args)
}

function refused(call: () => unknown): boolean {
  try {
    call()
    return false
  } catch (error) {
    if (error instanceof Error && error.message === REMOTE_UNAVAILABLE) return true
    throw error
  }
}

it('characterize: in-app, a host: lane or repository key never reaches a local handler', () => {
  const local = vi.fn()
  expect(refused(() => registered('fs:readDir', local)(LANE, `${LANE}/src`))).toBe(true)
  expect(refused(() => registered('git:statusMap', local)(REPO))).toBe(true)
  expect(refused(() => registered('git:removeWorktree', local)(REPO, LANE, {}))).toBe(true)
  expect(refused(() => registered('app:revealPath', local)(`${LANE}/a.ts`))).toBe(true)
  expect(local).not.toHaveBeenCalled()
})

it('characterize: in-app, runtime channels run their local handler with local paths', async () => {
  const local = vi.fn(async () => 'ran')
  expect(await registered('pi:createSession', local)({ workspacePath: '/w' })).toBe('ran')
  expect(await registered('sessions:list', local)('/w')).toBe('ran')
  expect(await registered('headroom:status', local)()).toBe('ran')
  expect(await registered('pty:create', local)('/w', 80, 24)).toBe('ran')
  expect(await registered('git:removeWorktree', local)('/w', '/w/.phosphor/worktrees/a', {})).toBe(
    'ran',
  )
  expect(local).toHaveBeenCalledTimes(5)
})
