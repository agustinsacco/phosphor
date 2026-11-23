import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { daemonLanePorts, type DaemonLanePortsInput } from './lane-ports'
import { createRunEndings } from './lane-reload'

let home: string | undefined
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
})

function input(over: Partial<DaemonLanePortsInput> = {}) {
  home = mkdtempSync(join(tmpdir(), 'h4-lane-ports-'))
  const publish = vi.fn()
  const laneCommand = vi.fn(async () => ({ success: true }))
  const reloadNow = vi.fn(async () => 'applied' as const)
  const ports: DaemonLanePortsInput = {
    runtime: { mcpControl: vi.fn(), reloadNow },
    laneCommand,
    live: { summaryFor: (id) => (id === 'L1' ? ({ laneId: 'L1' } as never) : null), publish },
    endings: createRunEndings(),
    pauses: () => null,
    env: {},
    home,
    platform: 'darwin',
    log: () => {},
    ...over,
  }
  return { ports, publish, laneCommand, reloadNow }
}

it('republishes a known lane’s summary and nothing for an unknown one', () => {
  const h = input()
  const built = daemonLanePorts(h.ports)
  built.laneRuntime!.publishSummary('L1')
  built.laneRuntime!.publishSummary('gone')
  expect(h.publish).toHaveBeenCalledExactlyOnceWith('L1', {
    kind: 'summary',
    summary: { laneId: 'L1' },
  })
})

it('offers no self-update without an installed release, and reports no pause without one', () => {
  const built = daemonLanePorts(input().ports)
  expect(built.serviceUpdate).toBeUndefined()
  expect(built.pauseState!()).toEqual({ kind: 'none' })
})

it('reloads through the runtime and continues through the lane command', async () => {
  const endings = createRunEndings()
  const h = input({ endings })
  endings.ended('s1', [{ role: 'toolResult', toolName: 'phosphor' }] as never)
  const target = { laneId: 'L1', sessionId: 's1', settledSessionId: 's1' }
  const reload = daemonLanePorts(h.ports).deferredActions.reload!
  expect(await reload({ kind: 'reload', what: 'skills' }, target)).toEqual({ ok: true })
  expect(h.reloadNow).toHaveBeenCalledWith('s1')
  expect(h.laneCommand).toHaveBeenCalledWith('s1', {
    type: 'prompt',
    message: 'Phosphor reloaded this lane: skills. Continue.',
  })
})
