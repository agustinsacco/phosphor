import { expect, it, vi } from 'vitest'
import { machineObservations } from './observations'
import { MACHINE } from '../../../../libs/client-ui/src/features/machines/__fixtures__/control'

it('records initial states, clock-corrected transitions, removal once, and clears account history', () => {
  const log = vi.fn()
  const observer = machineObservations(log)
  const lastSeenAt = '2026-01-01T00:00:00.000Z'
  const now = Date.parse(lastSeenAt) + 1000_000
  const observe = (machines = [MACHINE], age = 0) =>
    observer.observe(
      { machines, serverTime: new Date(Date.parse(lastSeenAt) + age).toISOString() },
      now,
      '0'.repeat(16),
    )
  observe()
  expect(log).toHaveBeenLastCalledWith(
    'machines',
    'observed',
    expect.objectContaining({ from: null, to: 'never connected' }),
  )
  observe()
  expect(log).toHaveBeenCalledTimes(1)
  const running = { ...MACHINE, lastSeenAt, state: 'running' as const }
  observe([running], 90_000)
  expect(log).toHaveBeenLastCalledWith(
    'machines',
    'observed',
    expect.objectContaining({ from: 'never connected', to: 'online' }),
  )
  observe([running], 90_001)
  expect(log).toHaveBeenLastCalledWith(
    'machines',
    'observed',
    expect.objectContaining({ from: 'online', to: 'offline', lastSeenAt }),
  )
  observe([])
  observe([])
  expect(log).toHaveBeenCalledTimes(4)
  expect(log).toHaveBeenLastCalledWith(
    'machines',
    'observed',
    expect.objectContaining({ from: 'offline', to: 'removed', hostId: MACHINE.id }),
  )
  observe()
  observer.clear()
  observe()
  expect(log).toHaveBeenLastCalledWith(
    'machines',
    'observed',
    expect.objectContaining({ from: null }),
  )
  expect(log).toHaveBeenCalledTimes(6)
})
it('tracks at most 1,000 hosts, with no repeated lines at the cap or one past it', () => {
  const log = vi.fn()
  const observer = machineObservations(log)
  const machines = Array.from({ length: 1001 }, (_, n) => ({ ...MACHINE, id: String(n) }))
  const observe = (list = machines) =>
    observer.observe({ machines: list, serverTime: MACHINE.enrolledAt }, 0, '0'.repeat(16))
  observe(machines.slice(0, 1000))
  expect(log).toHaveBeenCalledTimes(1000)
  observe()
  expect(log).toHaveBeenCalledTimes(1000)
  log.mockClear()
  observe([])
  expect(log).toHaveBeenCalledTimes(1000)
})
