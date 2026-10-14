import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import {
  TERMINAL_LIMITS as L,
  parseTerminalFrame,
  type TerminalFrame,
  type TerminalSummary,
} from '@phosphor/shared/host-protocol-terminals'
import type { StoredLane } from '../lanes/store'
import type { HostPtyModule } from './native'
import { createTerminals } from './service'
import { terminalState } from './state'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-terminals-')))
const lanes = new Map<string, StoredLane>()
const controller = randomUUID()
function lane() {
  const laneId = randomUUID()
  const row: StoredLane = {
    laneId,
    repositoryId: 'a'.repeat(16),
    cwd: root,
    worktree: false,
    sessionFile: null,
    removedAt: null,
    title: null,
    branch: null,
    model: null,
    activity: 'idle',
    control: { fence: 1, controller: { clientId: controller, label: 'Test', connected: true } },
    attention: 0,
    read: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  lanes.set(laneId, row)
  return row
}
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.splice(0).forEach((f) => f())
  lanes.clear()
  vi.useRealTimers()
})
function setup(native?: HostPtyModule) {
  let onData = (_: string) => {}
  let onExit = (_: { exitCode: number }) => {}
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((cb) => {
      onData = cb
      return { dispose() {} }
    }),
    onExit: vi.fn((cb) => {
      onExit = cb
      return { dispose() {} }
    }),
  }
  let saved: TerminalSummary[] = []
  const spawn = vi.fn(() => pty)
  const service = createTerminals({
    native: native ?? { spawn },
    context: {
      store: {
        getLane: (id) => lanes.get(id) ?? null,
        listRepositories: () => [{ id: 'a'.repeat(16), name: 'repo', path: root }],
      },
      env: {},
      home: root,
      log() {},
    },
    env: { PATH: '/usr/bin:/bin' },
    epoch: 'a'.repeat(16),
    shell: () => '/bin/sh',
    load: () => saved,
    save: (rows) => {
      saved = rows
    },
  })
  cleanup.push(service.close)
  return {
    service,
    pty,
    spawn,
    data: (s: string) => onData(s),
    exit: () => onExit({ exitCode: 0 }),
    saved: () => saved,
  }
}
async function create(f: ReturnType<typeof setup>, laneId: string) {
  const result: unknown = await f.service.execute(laneId, {
    type: 'terminal.create',
    cols: 80,
    rows: 24,
  })
  if (
    typeof result !== 'object' ||
    result === null ||
    !('terminalId' in result) ||
    typeof result.terminalId !== 'string'
  )
    throw new Error('invalid terminal id')
  return result.terminalId
}
describe('Host terminals', () => {
  it('uses only Host shell/environment/cwd and isolates lane mutations', async () => {
    const f = setup()
    const a = lane()
    const b = lane()
    const id = await create(f, a.laneId)
    expect(f.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-l'],
      expect.objectContaining({
        cwd: root,
        env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
      }),
    )
    await expect(
      f.service.execute(b.laneId, { type: 'terminal.kill', terminalId: id }),
    ).rejects.toThrow('bad-request')
    await f.service.execute(a.laneId, {
      type: 'terminal.resize',
      terminalId: id,
      cols: 90,
      rows: 30,
    })
    expect(f.pty.resize).toHaveBeenCalledWith(90, 30)
    await f.service.execute(a.laneId, { type: 'terminal.kill', terminalId: id })
    expect(f.pty.kill).toHaveBeenCalledOnce()
  })
  it('does not spawn after shutdown races directory validation', async () => {
    const f = setup()
    const a = lane()
    const pending = create(f, a.laneId)
    f.service.close()
    await expect(pending).rejects.toThrow('unavailable')
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('caps lane/Host occupancy including simultaneous creates', async () => {
    const f = setup()
    const a = lane()
    await Promise.all(Array.from({ length: 8 }, () => create(f, a.laneId)))
    await expect(create(f, a.laneId)).rejects.toThrow('too-many-requests')
    for (let n = 0; n < 3; n++) {
      const row = lane()
      await Promise.all(Array.from({ length: 8 }, () => create(f, row.laneId)))
    }
    await expect(create(f, lane().laneId)).rejects.toThrow('too-many-requests')
    expect(f.spawn).toHaveBeenCalledTimes(32)
  })
  it('admits only the current controller, consumes uncertain writes, bounds rates and never replays', async () => {
    const f = setup()
    const a = lane()
    const id = await create(f, a.laneId)
    const input = (seq: number, data = 'x', client = controller) =>
      f.service.input(client, { type: 'terminal.input', terminalId: id, seq, data })
    expect(input(1, 'x', randomUUID())).toBe(false)
    expect(input(2)).toBe(false)
    f.pty.write.mockImplementationOnce(() => {
      throw new Error('uncertain')
    })
    expect(input(1)).toBe(false)
    expect(input(1)).toBe(false)
    for (let seq = 2; seq <= 16; seq++) expect(input(seq, 'x'.repeat(4096))).toBe(true)
    expect(input(17, 'x'.repeat(4096))).toBe(false)
    expect(input(17, 'x'.repeat(4097))).toBe(false)
    expect(f.pty.write).toHaveBeenCalledTimes(16)
  })
  it('replays bounded Unicode output, resets stale/wrong/future cursors and survives disconnects', async () => {
    const f = setup()
    const a = lane()
    const id = await create(f, a.laneId)
    f.data('💡'.repeat(L.scrollbackBytes / 4 + 10000))
    const frames: TerminalFrame[] = []
    const sub = { type: 'subscribe' as const, topic: 'terminal' as const, id: 's', terminalId: id }
    const drop = f.service.subscribe(sub, (frame) => frames.push(frame))
    const reset = frames[0]
    expect(reset?.type).toBe('terminal.reset')
    if (reset?.type !== 'terminal.reset') throw new Error('missing reset')
    expect(Buffer.byteLength(reset.data)).toBeLessThanOrEqual(L.scrollbackBytes)
    expect(reset.data).not.toContain('\ufffd')
    drop?.()
    expect(f.pty.kill).not.toHaveBeenCalled()
    f.data('hello')
    frames.length = 0
    f.service.subscribe({ ...sub, after: { epoch: 'a'.repeat(16), seq: reset.seq } }, (frame) =>
      frames.push(frame),
    )?.()
    expect(frames).toMatchObject([{ type: 'terminal.output', data: 'hello' }])
    for (const after of [
      { epoch: 'b'.repeat(16), seq: reset.seq },
      { epoch: 'a'.repeat(16), seq: 0 },
      { epoch: 'a'.repeat(16), seq: 999999 },
    ]) {
      frames.length = 0
      f.service.subscribe({ ...sub, after }, (frame) => frames.push(frame))?.()
      expect(frames[0]?.type).toBe('terminal.reset')
    }
    expect(frames.every((frame) => parseTerminalFrame(frame) !== null)).toBe(true)
  })
  it('kills PTYs after lane deletion without a connected client and restores interrupted identities', async () => {
    vi.useFakeTimers()
    const f = setup()
    const a = lane()
    const id = await create(f, a.laneId)
    const state = terminalState(root)
    state.save(f.saved())
    expect(state.load()).toEqual(f.saved())
    const saved = f.saved()
    const restarted = createTerminals({
      native: { spawn: vi.fn() },
      context: {
        store: {
          getLane: (id) => lanes.get(id) ?? null,
          listRepositories: () => [{ id: a.repositoryId, name: 'repo', path: root }],
        },
        env: {},
        home: root,
        log() {},
      },
      env: {},
      epoch: 'b'.repeat(16),
      load: () => saved,
      save() {},
    })
    cleanup.push(restarted.close)
    expect(await restarted.feature.call('terminal.list', { laneId: a.laneId })).toEqual({
      ok: true,
      data: [{ terminalId: id, laneId: a.laneId, status: 'interrupted' }],
    })
    lanes.delete(a.laneId)
    vi.advanceTimersByTime(1000)
    expect(f.pty.kill).toHaveBeenCalledOnce()
    expect(f.saved()).toEqual([])
  })
  it('spawns, resizes, receives UTF-8 output and exits with the real node-pty', async () => {
    const native: HostPtyModule = createRequire(import.meta.url)(
      '../../../desktop/node_modules/node-pty',
    )
    const f = setup(native)
    const a = lane()
    const id = await create(f, a.laneId)
    const result = new Promise<void>((resolve, reject) => {
      let output = ''
      f.service.subscribe(
        { type: 'subscribe', topic: 'terminal', id: 's', terminalId: id },
        (frame) => {
          if (frame.type === 'terminal.output') output += frame.data
          if (frame.type === 'terminal.exit') {
            try {
              expect(output).toContain('host-pty-proof')
              expect(frame.exitCode).toBe(0)
              resolve()
            } catch (e) {
              reject(e)
            }
          }
        },
      )
    })
    await f.service.execute(a.laneId, {
      type: 'terminal.resize',
      terminalId: id,
      cols: 90,
      rows: 25,
    })
    expect(
      f.service.input(controller, {
        type: 'terminal.input',
        terminalId: id,
        seq: 1,
        data: "printf 'host-pty-proof\\n'; exit\r",
      }),
    ).toBe(true)
    await result
  })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
