import { describe, expect, it, vi } from 'vitest'
import type { OwnerChannel } from './migration/owner-channel'
import { restoreServicePorts, STANDBY_WAIT_MS } from './restore-service'

const MACHINE = '00000000-0000-4000-8000-0000000000aa'

function world(answers: { release?: () => unknown; local?: () => unknown; machineId?: string }) {
  let clock = 0
  const calls: string[] = []
  const closed = vi.fn()
  const channel = (): OwnerChannel => ({
    machineId: answers.machineId ?? MACHINE,
    call: (async (method: string) => {
      calls.push(method)
      if (method === 'machine.owner') return answers.release?.()
      return answers.local?.()
    }) as OwnerChannel['call'],
    close: closed,
  })
  const open = vi.fn(async () => channel())
  const ports = restoreServicePorts({
    open,
    now: () => clock,
    wait: async (ms) => {
      clock += ms
    },
    log: vi.fn(),
  })
  return { ports, calls, closed, open }
}

const lock = (held: boolean, standby: boolean) => ({
  ownerLock: { held, holder: held ? 'daemon' : null, pid: null, standby },
})

describe('break-glass restore against This Mac’s service', () => {
  it('stopLanes is the release: true once the service accepts it, false on its refusal', async () => {
    const ok = world({ release: () => lock(true, true).ownerLock })
    expect(await ok.ports.stopLanes(MACHINE)).toBe(true)
    expect(ok.calls).toEqual(['machine.owner'])
    expect(ok.closed).toHaveBeenCalled()
    const busy = world({
      release: () => {
        throw new Error("Stop this machine's 2 running lanes first.")
      },
    })
    expect(await busy.ports.stopLanes(MACHINE)).toBe(false)
    expect(busy.closed).toHaveBeenCalled()
  })

  it('never acts on another machine’s service, or none', async () => {
    const other = world({ release: () => lock(true, true).ownerLock, machineId: 'other' })
    expect(await other.ports.stopLanes(MACHINE)).toBe(false)
    expect(other.calls).toEqual([])
    const none = world({})
    none.open.mockResolvedValue(null as never)
    expect(await none.ports.stopLanes(MACHINE)).toBe(false)
  })

  it('releaseToStandby waits across the restart for a free lock in standby', async () => {
    const answers = [lock(true, true), lock(false, false), lock(false, true)]
    const w = world({ local: () => answers.shift() })
    expect(await w.ports.releaseToStandby(MACHINE)).toBe(true)
    expect(answers).toEqual([])
  })

  it('releaseToStandby gives up after its bound', async () => {
    const w = world({ local: () => lock(true, true) })
    expect(await w.ports.releaseToStandby(MACHINE)).toBe(false)
    expect(w.calls.length).toBeGreaterThan(STANDBY_WAIT_MS / 2000)
  })
})
