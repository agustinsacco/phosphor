import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PROVIDER_LOGIN_LIMITS } from '@phosphor/shared/host-protocol-providers'
import {
  TERMINAL_LIMITS as L,
  type TerminalSummary,
} from '@phosphor/shared/host-protocol-terminals'
import type { StoredLane } from '../lanes/store'
import { createTerminals, TerminalForbidden } from './service'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'terminal-lifecycle-')))
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))
afterAll(() => rmSync(root, { recursive: true, force: true }))
function setup(restored: TerminalSummary[] = []) {
  const owner = randomUUID()
  const lane: Omit<StoredLane, 'removedAt'> & { removedAt: string | null } = {
    laneId: randomUUID(),
    repositoryId: 'a'.repeat(16),
    cwd: root,
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
  let time = 1000
  let exit = (_: { exitCode: number }) => {}
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose() {} })),
    onExit(cb: typeof exit) {
      exit = cb
      return { dispose() {} }
    },
  }
  let saved: TerminalSummary[] = []
  const save = vi.fn((rows: TerminalSummary[]) => {
    saved = rows
  })
  const spawn = vi.fn(() => pty)
  const service = createTerminals({
    native: { spawn },
    context: {
      store: {
        getLane: (id) => (id === lane.laneId ? lane : null),
        listRepositories: () => [{ id: lane.repositoryId, name: 'repo', path: root }],
      },
      env: {},
      home: root,
      log() {},
    },
    env: { HOST_ONLY: 'yes' },
    epoch: 'a'.repeat(16),
    shell: () => '/bin/sh',
    now: () => time,
    load: () => restored,
    save,
  })
  cleanup.push(service.close)
  const create = (authorized?: () => boolean) =>
    service.execute(lane.laneId, { type: 'terminal.create', cols: 80, rows: 24 }, authorized)
  return {
    service,
    lane,
    owner,
    pty,
    save,
    spawn,
    create,
    saved: () => saved,
    advance: (ms: number) => {
      time += ms
    },
    exit: () => exit({ exitCode: 0 }),
  }
}
function terminalId(result: unknown): string {
  if (
    !result ||
    typeof result !== 'object' ||
    !('terminalId' in result) ||
    typeof result.terminalId !== 'string'
  )
    throw new Error('missing terminal id')
  return result.terminalId
}
describe('terminal lifecycle characterization', () => {
  it('rechecks authority and shutdown after directory I/O before spawning', async () => {
    const f = setup()
    let authorized = true
    const pending = f.create(() => authorized)
    authorized = false
    await expect(pending).rejects.toBeInstanceOf(TerminalForbidden)
    const stopped = f.create()
    f.service.close()
    await expect(stopped).rejects.toThrow('unavailable')
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('rechecks lane liveness and concurrent caps after directory I/O', async () => {
    const f = setup()
    const pending = f.create()
    f.lane.removedAt = 'removed'
    await expect(pending).rejects.toThrow('unknown-lane')
    f.lane.removedAt = null
    const creates = await Promise.allSettled(
      Array.from({ length: L.perLane + 1 }, () => f.create()),
    )
    expect(creates.filter((result) => result.status === 'fulfilled')).toHaveLength(L.perLane)
    expect(creates.filter((result) => result.status === 'rejected')).toEqual([
      { status: 'rejected', reason: new Error('too-many-requests') },
    ])
    expect(f.spawn).toHaveBeenCalledTimes(L.perLane)
  })
  it('records before spawn and reclaims a failed persistence or partially started PTY', async () => {
    const f = setup()
    f.save.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(f.create()).rejects.toThrow('unavailable')
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.saved()).toEqual([])
    f.spawn.mockImplementationOnce(() => {
      expect(f.saved()).toEqual([
        expect.objectContaining({ laneId: f.lane.laneId, status: 'running' }),
      ])
      return f.pty
    })
    f.pty.onData.mockImplementationOnce(() => {
      throw new Error('binding failed')
    })
    await expect(f.create()).rejects.toThrow('unavailable')
    expect(f.pty.kill).toHaveBeenCalledOnce()
    expect(f.saved()).toEqual([])
  })
  it('restores interrupted identity without spawning and closes live PTYs on exit persistence failure', async () => {
    const f = setup()
    const id = terminalId(await f.create())
    const restarted = setup(f.saved())
    // Reaping depends on the original lane identity, so observe the initial save before listing.
    expect(restarted.saved()).toEqual([
      { terminalId: id, laneId: f.lane.laneId, status: 'interrupted' },
    ])
    expect(restarted.spawn).not.toHaveBeenCalled()
    await f.create()
    f.save.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    f.exit()
    expect(f.pty.kill).toHaveBeenCalledOnce()
    await expect(f.create()).rejects.toThrow('unavailable')
  })
  it('consumes uncertain input sequence and byte budget before write, then renews the rate window', async () => {
    const f = setup()
    const id = terminalId(await f.create())
    const input = (seq: number, data = 'x'.repeat(L.inputBytes)) =>
      f.service.input(f.owner, { type: 'terminal.input', terminalId: id, seq, data })
    f.pty.write.mockImplementationOnce(() => {
      throw new Error('uncertain')
    })
    expect(input(1)).toBe(false)
    expect(input(1)).toBe(false)
    for (let n = 2; n <= 16; n++) expect(input(n)).toBe(true)
    expect(input(17)).toBe(false)
    f.advance(1000)
    expect(input(17)).toBe(true)
    expect(f.pty.write).toHaveBeenCalledTimes(17)
  })
  it('keeps lane PTYs across disconnect, reaps disconnected login at the deadline and revokes immediately', async () => {
    const f = setup()
    const id = terminalId(await f.create())
    let loginId = ''
    const run = f.service.loginRunner(f.owner, (value) => {
      loginId = value
    })('/host/login', [], { cwd: root, env: {} })
    f.service.presence(f.owner, false)
    f.advance(PROVIDER_LOGIN_LIMITS.disconnectMs - 1)
    const watch = () =>
      f.service.subscribe(
        { type: 'subscribe', topic: 'terminal', id: 's', terminalId: id },
        () => {},
      )
    watch()?.()
    expect(f.pty.kill).not.toHaveBeenCalled()
    f.advance(1)
    watch()?.()
    await expect(run).resolves.toEqual({ code: null })
    expect(f.pty.kill).toHaveBeenCalledOnce()
    expect(
      f.service.subscribe(
        { type: 'subscribe', topic: 'terminal', id: 's', terminalId: loginId },
        () => {},
        f.owner,
      ),
    ).toBeNull()
    const revoked = f.service.loginRunner(f.owner, () => {})('/host/login', [], {
      cwd: root,
      env: {},
    })
    f.service.presence(f.owner, false, true)
    await expect(revoked).resolves.toEqual({ code: null })
    expect(f.pty.kill).toHaveBeenCalledTimes(2)
    expect(
      f.service.input(f.owner, {
        type: 'terminal.input',
        terminalId: id,
        seq: 1,
        data: 'still live',
      }),
    ).toBe(true)
  })
})
