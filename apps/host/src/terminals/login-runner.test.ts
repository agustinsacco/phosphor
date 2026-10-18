import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TERMINAL_LIMITS as L } from '@phosphor/shared/host-protocol-terminals'
import { createEntry, createTerminalState } from './service-state'
import { loginRunner, machineOp } from './login-runner'
import { TerminalForbidden } from './service'
import { subscribe } from './subscriptions'

function setup() {
  let data = (_: string) => {}
  let exit = (_: { exitCode: number }) => {}
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(cb: typeof data) {
      data = cb
      return { dispose() {} }
    },
    onExit: vi.fn((cb: typeof exit) => {
      exit = cb
      return { dispose() {} }
    }),
  }
  const spawn = vi.fn(() => pty)
  const save = vi.fn()
  const state = createTerminalState({
    native: { spawn },
    context: {
      store: { getLane: () => null, listRepositories: () => [] },
      env: {},
      home: '/',
      log() {},
    },
    env: { NOT_LOGIN_ENV: 'no' },
    epoch: 'a'.repeat(16),
    now: () => 1234,
    load: () => [],
    save,
  })
  const started = vi.fn()
  const run = () =>
    loginRunner(state, 'owner', started)('/host/login', ['auth', 'login'], {
      cwd: '/host/tmp',
      env: { LOGIN_ONLY: 'yes' },
    })
  const entry = () => {
    const row = [...state.entries.values()][0]
    if (!row) throw new Error('missing terminal')
    return row
  }
  return {
    state,
    pty,
    spawn,
    save,
    started,
    run,
    entry,
    data: (s: string) => data(s),
    exit: (code: number) => exit({ exitCode: code }),
  }
}
describe('terminal login runner', () => {
  it('uses only the Host login program/options and never persists sensitive login state', async () => {
    const f = setup()
    const run = f.run()
    expect(f.spawn).toHaveBeenCalledWith('/host/login', ['auth', 'login'], {
      cwd: '/host/tmp',
      env: { LOGIN_ONLY: 'yes' },
      cols: 80,
      rows: 24,
      name: 'xterm-256color',
    })
    expect(f.started).toHaveBeenCalledWith(f.entry().terminalId)
    f.data('private')
    expect(f.entry().chunks[0]?.data).toBe('private')
    expect(f.save).not.toHaveBeenCalled()
    f.exit(0)
    await expect(run).resolves.toEqual({ code: null })
  })
  it('allows only the login owner to resize/kill and forbids machine create or lane mutations', async () => {
    const f = setup()
    const run = f.run()
    const terminalId = f.entry().terminalId
    const resize = { type: 'terminal.resize' as const, terminalId, cols: 100, rows: 40 }
    expect(() => machineOp(f.state, 'other', resize)).toThrow(TerminalForbidden)
    expect(() =>
      machineOp(f.state, 'owner', { type: 'terminal.create', cols: 80, rows: 24 }),
    ).toThrow(TerminalForbidden)
    expect(() =>
      machineOp(f.state, 'owner', { type: 'terminal.kill', terminalId: randomUUID() }),
    ).toThrow(TerminalForbidden)
    expect(machineOp(f.state, 'owner', resize)).toBeNull()
    expect(f.pty.resize).toHaveBeenCalledWith(100, 40)
    machineOp(f.state, 'owner', { type: 'terminal.kill', terminalId })
    await expect(run).resolves.toEqual({ code: null })
    expect(f.state.entries.size).toBe(0)
    expect(f.pty.kill).toHaveBeenCalledOnce()
    const laneEntry = createEntry({
      terminalId: randomUUID(),
      laneId: randomUUID(),
      status: 'running',
    })
    f.state.entries.set(laneEntry.terminalId, laneEntry)
    expect(() =>
      machineOp(f.state, 'owner', { type: 'terminal.kill', terminalId: laneEntry.terminalId }),
    ).toThrow(TerminalForbidden)
  })
  it('keeps only a content-free exit tombstone when exit beats the started notification', async () => {
    const f = setup()
    f.pty.onExit.mockImplementationOnce((cb) => {
      cb({ exitCode: 5 })
      return { dispose() {} }
    })
    await expect(f.run()).resolves.toEqual({ code: null })
    expect(f.started).toHaveBeenCalledWith(f.entry().terminalId)
    expect(f.entry()).toMatchObject({
      status: 'exited',
      chunks: [],
      outputBytes: 0,
      exitCode: 5,
      login: { disconnectedAt: 1234 },
    })
    f.data('late secret')
    expect(f.entry().chunks).toEqual([])
    expect(
      machineOp(f.state, 'owner', {
        type: 'terminal.resize',
        terminalId: f.entry().terminalId,
        cols: 80,
        rows: 24,
      }),
    ).toBeNull()
  })
  it('removes watched login exits immediately and delivers their observed code', async () => {
    const f = setup()
    const run = f.run()
    const send = vi.fn()
    subscribe(
      f.state,
      () => {},
      { type: 'subscribe', topic: 'terminal', id: 'watch', terminalId: f.entry().terminalId },
      send,
      'owner',
    )
    f.data('private')
    const entry = f.entry()
    f.exit(6)
    await expect(run).resolves.toEqual({ code: null })
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'terminal.exit', exitCode: 6 }),
    )
    expect(f.state.entries.size).toBe(0)
    expect(entry.chunks).toEqual([])
    expect(entry.listeners.size).toBe(0)
  })
  it('refuses closed/full services without spawning or announcing a terminal', async () => {
    const f = setup()
    f.state.closed = true
    await expect(f.run()).resolves.toEqual({ code: null, error: 'unavailable' })
    expect(() =>
      machineOp(f.state, 'owner', { type: 'terminal.kill', terminalId: randomUUID() }),
    ).toThrow(TerminalForbidden)
    f.state.closed = false
    for (let n = 0; n < L.perHost; n++) {
      const row = createEntry({ terminalId: randomUUID(), laneId: randomUUID(), status: 'running' })
      f.state.entries.set(row.terminalId, row)
    }
    await expect(f.run()).resolves.toEqual({ code: null, error: 'unavailable' })
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.started).not.toHaveBeenCalled()
  })
  it('reclaims failed spawns and failed started callbacks, preserving completion semantics', async () => {
    const f = setup()
    f.spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    // kill resolves the existing login before the catch attempts its unavailable result.
    await expect(f.run()).resolves.toEqual({ code: null })
    expect(f.state.entries.size).toBe(0)
    expect(f.started).not.toHaveBeenCalled()
    f.started.mockImplementationOnce(() => {
      throw new Error('delivery failed')
    })
    await expect(f.run()).resolves.toEqual({ code: null })
    expect(f.state.entries.size).toBe(0)
    expect(f.pty.kill).toHaveBeenCalledOnce()
  })
})
