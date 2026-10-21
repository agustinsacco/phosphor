import { describe, expect, it, vi } from 'vitest'
import { createRemoteTerminals } from './terminals'
import type { TerminalConnection } from './terminal-state'

const RUNNING = '11111111-1111-4111-8111-111111111111'
const CREATED = '22222222-2222-4222-8222-222222222222'

/** Only the connection surface the bridge reads; the real socket is covered in terminals.test.ts. */
function setup(options: { machineShell?: boolean; listed?: unknown[] } = {}) {
  const snapshot = {
    state: 'ready',
    machineShell: options.machineShell ?? true,
    capabilities: ['terminal', 'sessions.control'],
    lanes: [],
  }
  const call = vi.fn(async () => ({ ok: true, data: options.listed ?? [] }))
  const send = vi.fn(async (op: { type: string }) => ({
    requestId: 'r',
    status: 'done',
    data: op.type === 'terminal.create' ? { terminalId: CREATED } : null,
  }))
  const connection = {
    snapshot: () => snapshot,
    incarnation: () => ({ generation: 1, runtimeEpoch: 'a'.repeat(16) }),
    call,
    send,
  } as unknown as TerminalConnection
  const bridge = createRemoteTerminals({
    connection: () => connection,
    lane: () => {
      throw new Error('no lanes')
    },
    clientId: () => 'me',
    emit: vi.fn(),
  })
  return { bridge, call, send, snapshot }
}

describe('machine shell bridge', () => {
  it('asks an older Host to update instead of sending anything', async () => {
    const f = setup({ machineShell: false })
    await expect(f.bridge.shell(1, 'host', 80, 24)).rejects.toThrow('Update this Host')
    expect(f.call).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('attaches to the running machine shell rather than starting another', async () => {
    const f = setup({ listed: [{ terminalId: RUNNING, laneId: '', status: 'running' }] })
    const first = await f.bridge.shell(1, 'host', 80, 24)
    expect(f.call).toHaveBeenCalledWith('terminal.list', {})
    expect(f.send).not.toHaveBeenCalled()
    // The same window asking again gets the same handle, so a page can reattach.
    expect(await f.bridge.shell(1, 'host', 80, 24)).toEqual(first)
  })

  it('creates a lane-less shell when none is running, and detaches on window close', async () => {
    const f = setup({ listed: [{ terminalId: RUNNING, laneId: '', status: 'exited' }] })
    const { ptyId } = await f.bridge.shell(1, 'host', 100, 30)
    expect(ptyId).toMatch(/^remote-pty-/)
    expect(f.send).toHaveBeenCalledWith({ type: 'terminal.create', cols: 100, rows: 30 })
    f.bridge.clear(1)
    // A shared shell outlives the window that opened it: no kill is sent.
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('rechecks the owner and authority after listing before it can create', async () => {
    const f = setup()
    f.call.mockImplementation(async () => {
      f.bridge.clear(1)
      return { ok: true, data: [] }
    })
    await expect(f.bridge.shell(1, 'host', 80, 24)).rejects.toThrow()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('refuses without control or the terminal capability', async () => {
    const f = setup()
    f.snapshot.capabilities = ['terminal']
    await expect(f.bridge.shell(1, 'host', 80, 24)).rejects.toThrow()
    f.snapshot.capabilities = ['sessions.control']
    await expect(f.bridge.shell(1, 'host', 80, 24)).rejects.toThrow()
    expect(f.send).not.toHaveBeenCalled()
  })
})
