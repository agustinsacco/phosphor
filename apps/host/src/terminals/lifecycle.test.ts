import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PROVIDER_LOGIN_LIMITS } from '@phosphor/shared/host-protocol-providers'
import type { StoredLane } from '../lanes/store'
import { createEntry, createTerminalState } from './service-state'
import { alive, close, kill, persist, presence, reap } from './lifecycle'

function setup() {
  let time = 1000
  const lane: Omit<StoredLane, 'removedAt'> & { removedAt: string | null } = {
    laneId: randomUUID(),
    repositoryId: 'a'.repeat(16),
    cwd: '/',
    worktree: false,
    sessionFile: null,
    removedAt: null,
    title: null,
    branch: null,
    model: null,
    activity: 'idle',
    control: { fence: 0, controller: null },
    attention: 0,
    read: 0,
    createdAt: '',
    updatedAt: '',
  }
  const save = vi.fn()
  const repositories = vi.fn(() => [{ id: lane.repositoryId, name: 'repo', path: '/' }])
  const state = createTerminalState({
    native: {
      spawn() {
        throw new Error('unused')
      },
    },
    context: {
      store: {
        getLane: (id) => (id === lane.laneId ? lane : null),
        listRepositories: repositories,
      },
      env: {},
      home: '/',
      log() {},
    },
    env: {},
    epoch: 'a'.repeat(16),
    now: () => time,
    load: () => [],
    save,
  })
  const entry = createEntry({ terminalId: randomUUID(), laneId: lane.laneId, status: 'running' })
  const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() }
  entry.pty = pty
  state.entries.set(entry.terminalId, entry)
  return {
    state,
    entry,
    pty,
    lane,
    save,
    repositories,
    advance: (ms: number) => {
      time += ms
    },
  }
}
afterEach(() => vi.useRealTimers())
describe('terminal lifecycle', () => {
  it('persists only lane identity/status, restores interrupted identities and excludes login contents', () => {
    const { state, entry, save } = setup()
    entry.chunks.push({ seq: 1, data: 'private', bytes: 7 })
    const login = createEntry({ terminalId: randomUUID(), laneId: '', status: 'running' })
    login.login = { owner: 'owner', finish() {} }
    state.entries.set(login.terminalId, login)
    persist(state)
    const rows = [{ terminalId: entry.terminalId, laneId: entry.laneId, status: 'running' }]
    expect(save).toHaveBeenCalledWith(rows)
    const restored = createTerminalState({ ...state.options, load: () => rows })
    expect(restored.entries.get(entry.terminalId)).toMatchObject({
      status: 'interrupted',
      chunks: [],
      inputSeq: 0,
    })
  })
  it('requires a nonremoved lane and a configured repository to stay alive', () => {
    const { state, lane, repositories } = setup()
    expect(alive(state, lane.laneId)).toBe(true)
    expect(alive(state, randomUUID())).toBeNull()
    lane.removedAt = 'removed'
    expect(alive(state, lane.laneId)).toBe(false)
    lane.removedAt = null
    repositories.mockReturnValue([])
    expect(alive(state, lane.laneId)).toBe(false)
  })
  it('forces exit once, erases login buffers and tolerates an already dead PTY', () => {
    const { state, entry, pty } = setup()
    const finish = vi.fn()
    const send = vi.fn()
    entry.login = { owner: 'owner', finish }
    entry.chunks = [{ seq: 1, data: 'secret', bytes: 6 }]
    entry.outputBytes = 6
    entry.listeners.add(send)
    pty.kill.mockImplementation(() => {
      throw new Error('already gone')
    })
    kill(state, entry)
    kill(state, entry)
    expect(entry).toMatchObject({
      status: 'exited',
      pty: undefined,
      chunks: [],
      outputBytes: 0,
      exitCode: -1,
    })
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal.exit', exitCode: -1 }),
    )
    expect(finish).toHaveBeenCalledWith({ code: null })
    expect(pty.kill).toHaveBeenCalledOnce()
  })
  it('reaps deleted lanes and disconnected logins only at their deadline', () => {
    const { state, entry, lane, pty, save, advance } = setup()
    const login = createEntry({ terminalId: randomUUID(), laneId: '', status: 'running' })
    login.login = { owner: 'owner', disconnectedAt: 1000, finish: vi.fn() }
    login.pty = { ...pty, kill: vi.fn() }
    state.entries.set(login.terminalId, login)
    reap(state)
    expect(save).not.toHaveBeenCalled()
    lane.removedAt = 'removed'
    reap(state)
    expect(state.entries.has(entry.terminalId)).toBe(false)
    expect(state.entries.has(login.terminalId)).toBe(true)
    advance(PROVIDER_LOGIN_LIMITS.disconnectMs)
    reap(state)
    expect(state.entries.size).toBe(0)
    expect(login.login.finish).toHaveBeenCalledWith({ code: null })
    expect(save).toHaveBeenLastCalledWith([])
  })
  it('reconnects only the matching running login and revokes it without touching lane PTYs', () => {
    const { state, entry, pty } = setup()
    const login = createEntry({ terminalId: randomUUID(), laneId: '', status: 'running' })
    login.login = { owner: 'owner', finish: vi.fn() }
    login.pty = { ...pty, kill: vi.fn() }
    state.entries.set(login.terminalId, login)
    presence(state, 'other', false)
    expect(login.login.disconnectedAt).toBeUndefined()
    presence(state, 'owner', false)
    expect(login.login.disconnectedAt).toBe(1000)
    presence(state, 'owner', true)
    expect(login.login.disconnectedAt).toBeUndefined()
    presence(state, 'owner', false, true)
    expect(state.entries.has(login.terminalId)).toBe(false)
    expect(state.entries.has(entry.terminalId)).toBe(true)
    expect(pty.kill).not.toHaveBeenCalled()
  })
  it('closes all PTYs, clears listeners and cancels the timer idempotently', () => {
    vi.useFakeTimers()
    const { state, entry, pty } = setup()
    state.timer = setInterval(() => {}, 1000)
    entry.listeners.add(vi.fn())
    close(state)
    close(state)
    expect(state.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(pty.kill).toHaveBeenCalledOnce()
    expect(entry.listeners.size).toBe(0)
  })
})
