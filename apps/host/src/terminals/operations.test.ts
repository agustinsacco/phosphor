import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TERMINAL_LIMITS as L } from '@phosphor/shared/host-protocol-terminals'
import type { StoredLane } from '../lanes/store'
import { laneRoot } from '../features/files'
import { createEntry, createTerminalState } from './service-state'
import { execute, input, terminalFeature, TerminalForbidden } from './operations'

vi.mock('../features/files', () => ({ laneRoot: vi.fn(async () => '/host/repo') }))
afterEach(() => vi.clearAllMocks())
function setup() {
  let time = 1000
  let data = (_: string) => {}
  let exit = (_: { exitCode: number }) => {}
  const owner = randomUUID()
  const lane: Omit<StoredLane, 'removedAt'> & { removedAt: string | null } = {
    laneId: randomUUID(),
    repositoryId: 'a'.repeat(16),
    cwd: '/host/repo',
    worktree: false,
    sessionFile: null,
    removedAt: null,
    title: null,
    branch: null,
    model: null,
    activity: 'idle',
    control: { fence: 1, controller: { clientId: owner, label: 'test', connected: true } },
    attention: 0,
    read: 0,
    createdAt: '',
    updatedAt: '',
  }
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(cb: typeof data) {
      data = cb
      return { dispose() {} }
    },
    onExit(cb: typeof exit) {
      exit = cb
      return { dispose() {} }
    },
  }
  const save = vi.fn()
  const spawn = vi.fn(() => pty)
  const state = createTerminalState({
    native: { spawn },
    context: {
      store: {
        getLane: () => lane,
        listRepositories: () => [{ id: lane.repositoryId, name: 'repo', path: '/host/repo' }],
      },
      env: {},
      home: '/',
      log() {},
    },
    env: { HOST_ONLY: 'yes' },
    epoch: 'a'.repeat(16),
    now: () => time,
    shell: () => '/bin/sh',
    load: () => [],
    save,
  })
  const create = (authorized?: () => boolean) =>
    execute(state, lane.laneId, { type: 'terminal.create', cols: 90, rows: 30 }, authorized)
  const entry = () => {
    const row = [...state.entries.values()][0]
    if (!row) throw new Error('missing terminal')
    return row
  }
  return {
    state,
    lane,
    owner,
    pty,
    save,
    spawn,
    create,
    entry,
    data: (s: string) => data(s),
    exit: (code: number) => exit({ exitCode: code }),
    advance: (ms: number) => {
      time += ms
    },
  }
}
describe('terminal operations', () => {
  it('records identity before spawning only the Host shell/environment/cwd and handles resize/kill', async () => {
    const f = setup()
    f.spawn.mockImplementationOnce(() => {
      expect(f.save).toHaveBeenCalledWith([
        { terminalId: f.entry().terminalId, laneId: f.lane.laneId, status: 'running' },
      ])
      return f.pty
    })
    await f.create()
    expect(f.spawn).toHaveBeenCalledWith('/bin/sh', ['-l'], {
      cwd: '/host/repo',
      cols: 90,
      rows: 30,
      name: 'xterm-256color',
      env: { HOST_ONLY: 'yes', TERM: 'xterm-256color' },
    })
    const entry = f.entry()
    await execute(f.state, f.lane.laneId, {
      type: 'terminal.resize',
      terminalId: entry.terminalId,
      cols: 100,
      rows: 40,
    })
    expect(f.pty.resize).toHaveBeenCalledWith(100, 40)
    f.data('hello')
    expect(entry.chunks[0]?.data).toBe('hello')
    await execute(f.state, f.lane.laneId, { type: 'terminal.kill', terminalId: entry.terminalId })
    expect(f.state.entries.size).toBe(0)
    expect(f.pty.kill).toHaveBeenCalledOnce()
    expect(f.save).toHaveBeenLastCalledWith([])
  })
  it('checks authorization before parsing and rechecks authority and shutdown after I/O', async () => {
    const f = setup()
    await expect(f.create(() => false)).rejects.toBeInstanceOf(TerminalForbidden)
    expect(laneRoot).not.toHaveBeenCalled()
    const authorized = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    await expect(f.create(authorized)).rejects.toBeInstanceOf(TerminalForbidden)
    const pending = f.create()
    f.state.closed = true
    await expect(pending).rejects.toThrow('unavailable')
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('rechecks liveness and lane/Host caps after awaits under simultaneous creates', async () => {
    const f = setup()
    const pending = f.create()
    f.lane.removedAt = 'removed'
    await expect(pending).rejects.toThrow('unknown-lane')
    f.lane.removedAt = null
    const results = await Promise.allSettled(
      Array.from({ length: L.perLane + 1 }, () => f.create()),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(L.perLane)
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      { status: 'rejected', reason: new Error('too-many-requests') },
    ])
    f.state.entries.clear()
    for (let n = 0; n < L.perHost; n++) {
      const row = createEntry({ terminalId: randomUUID(), laneId: randomUUID(), status: 'running' })
      f.state.entries.set(row.terminalId, row)
    }
    await expect(f.create()).rejects.toThrow('too-many-requests')
  })
  it('rejects malformed dimensions, unsafe Host shells, wrong-lane mutations and unavailable resize', async () => {
    const f = setup()
    await expect(
      execute(f.state, f.lane.laneId, { type: 'terminal.create', cols: 0, rows: 1 }),
    ).rejects.toThrow('bad-request')
    f.state.options.shell = () => 'relative/sh'
    await expect(f.create()).rejects.toThrow('unavailable')
    f.state.options.shell = () => '/bin/sh\0'
    await expect(f.create()).rejects.toThrow('unavailable')
    f.state.options.shell = () => '/bin/sh'
    await f.create()
    const terminalId = f.entry().terminalId
    await expect(
      execute(f.state, randomUUID(), { type: 'terminal.kill', terminalId }),
    ).rejects.toThrow('bad-request')
    f.exit(0)
    await expect(
      execute(f.state, f.lane.laneId, { type: 'terminal.resize', terminalId, cols: 80, rows: 24 }),
    ).rejects.toThrow('unavailable')
  })
  it('reclaims failed spawn/persistence and shuts down remaining PTYs when natural exit cannot persist', async () => {
    const f = setup()
    f.spawn.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    await expect(f.create()).rejects.toThrow('unavailable')
    expect(f.state.entries.size).toBe(0)
    f.save.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(f.create()).rejects.toThrow('unavailable')
    expect(f.state.entries.size).toBe(0)
    await f.create()
    await f.create()
    f.save.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    f.exit(4)
    expect(f.state.closed).toBe(true)
    expect(f.pty.kill).toHaveBeenCalledOnce()
  })
  it('emits natural exit once even if the native exit callback repeats', async () => {
    const f = setup()
    await f.create()
    const send = vi.fn()
    f.entry().listeners.add(send)
    f.exit(3)
    f.exit(0)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'terminal.exit', exitCode: 3 }),
    )
  })
  it('consumes uncertain writes, enforces controller/sequence/rate and resets the rate window', async () => {
    const f = setup()
    await f.create()
    const frame = {
      type: 'terminal.input' as const,
      terminalId: f.entry().terminalId,
      seq: 1,
      data: 'x'.repeat(L.inputBytes),
    }
    expect(input(f.state, 'other', frame)).toBe(false)
    expect(input(f.state, f.owner, { ...frame, seq: 0 })).toBe(false)
    f.pty.write.mockImplementationOnce(() => {
      throw new Error('uncertain')
    })
    expect(input(f.state, f.owner, frame)).toBe(false)
    expect(input(f.state, f.owner, frame)).toBe(false)
    for (let seq = 2; seq <= 16; seq++)
      expect(input(f.state, f.owner, { ...frame, seq })).toBe(true)
    expect(input(f.state, f.owner, { ...frame, seq: 17 })).toBe(false)
    f.advance(1000)
    expect(input(f.state, f.owner, { ...frame, seq: 17 })).toBe(true)
    f.lane.removedAt = 'removed'
    expect(input(f.state, f.owner, { ...frame, seq: 18 })).toBe(false)
    f.state.closed = true
    expect(input(f.state, f.owner, { ...frame, seq: 18 })).toBe(false)
  })
  it('lists only the requested lane and returns unchanged errors for invalid/unavailable requests', async () => {
    const f = setup()
    await f.create()
    const feature = terminalFeature(f.state)
    expect(await feature.call('terminal.list', { laneId: f.lane.laneId })).toEqual({
      ok: true,
      data: [{ terminalId: f.entry().terminalId, laneId: f.lane.laneId, status: 'running' }],
    })
    expect(await feature.call('wrong', {})).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
    vi.mocked(laneRoot).mockRejectedValueOnce(new Error('unknown-lane'))
    expect(await feature.call('terminal.list', { laneId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: 'unknown-lane' },
    })
    f.state.closed = true
    expect(await feature.call('terminal.list', { laneId: f.lane.laneId })).toMatchObject({
      ok: false,
      error: { code: 'internal' },
    })
  })
})
