import { expect, it } from 'vitest'
import { machineHeadline, machineReachability } from './machineReachability'
import { MACHINE } from './__fixtures__/control'
const now = Date.parse('2026-10-01T00:00:00Z')
const online = {
  ...MACHINE,
  lastSeenAt: new Date(now).toISOString(),
  state: 'running' as const,
  readiness: { pi: 'ok' as const, claude: 'ok' as const, tailscale: 'ok' as const },
}
const addressed = { ...online, endpoint: 'https://host.example:47615' }

it('distinguishes every connection blocker and its exact recovery command', () => {
  expect(machineReachability(MACHINE, undefined, now)).toMatchObject({
    short: 'Never connected',
    command: 'phosphor setup',
  })
  expect(machineReachability(online, 'no-address', now)).toMatchObject({
    ok: false,
    short: 'Not reachable yet',
    command: 'sudo tailscale set --operator=$USER && phosphor setup',
  })
  expect(
    machineReachability({ ...addressed, state: 'stopping' }, 'connecting', now).detail,
  ).toContain('has not checked in')
  expect(machineReachability(addressed, 'down', now + 600_000).detail).toContain('since 10 min ago')
  // Offline wins over a missing address: nothing is running to publish one.
  expect(machineReachability(online, 'down', now + 600_000)).toMatchObject({
    short: 'Host offline',
    command: 'phosphor service restart',
  })
  for (const connection of ['connecting', 'reconnecting'] as const)
    expect(machineReachability(addressed, connection, now).short).toBe('Connecting…')
  expect(machineReachability(addressed, 'ready', now).ok).toBe(true)
})

it('asks a Mac Host only for setup, and names a stopped Tailscale before the operator', () => {
  expect(machineReachability({ ...online, platform: 'darwin' }, 'no-address', now).command).toBe(
    'phosphor setup',
  )
  const stopped = { ...online, readiness: { ...online.readiness, tailscale: 'stopped' as const } }
  expect(machineReachability(stopped, 'no-address', now)).toMatchObject({
    short: 'Tailscale stopped',
    command: 'phosphor setup',
  })
})

it('never offers a lane-stopping restart for a Host that is checking in', () => {
  for (const connection of ['down', 'signed-out', undefined] as const) {
    const reach = machineReachability(addressed, connection, now)
    expect(reach.short).toBe('Not reachable')
    expect(reach.command).toBeUndefined()
    expect(reach.detail).toContain('Tailscale is on here')
  }
  expect(machineReachability(addressed, 'unsupported', now)).toMatchObject({
    short: 'Update needed',
    command: 'phosphor update',
  })
  expect(machineReachability(addressed, 'wrong-machine', now).short).toBe('Identity mismatch')
  expect(machineReachability(addressed, 'reconnecting', now, 'forbidden').short).toBe(
    'Access refused',
  )
  expect(machineReachability(addressed, 'reconnecting', now, 'offline').short).toBe('Connecting…')
})

it('gives each machine exactly one headline and tone', () => {
  const headline = (m: typeof MACHINE, state?: Parameters<typeof machineHeadline>[1]) => {
    const h = machineHeadline(m, state, now)
    return [h.tone, h.label]
  }
  expect(headline(addressed, { state: 'ready' })).toEqual(['ok', 'Connected'])
  expect(headline(MACHINE)).toEqual(['pending', 'Waiting for setup'])
  expect(headline(online, { state: 'no-address' })).toEqual(['warn', 'Not reachable'])
  expect(headline(addressed, { state: 'connecting' })).toEqual(['pending', 'Connecting…'])
  expect(headline(addressed, { state: 'wrong-machine' })).toEqual(['error', 'Identity mismatch'])
  expect(headline({ ...addressed, state: 'stopping' })).toEqual(['off', 'Stopping'])
  // A stopping beat is a Host's last word: once it is old, the Host is offline.
  const stopped = {
    ...addressed,
    state: 'stopping' as const,
    lastSeenAt: new Date(now - 91_000).toISOString(),
  }
  expect(headline(stopped)).toEqual(['off', 'Offline'])
  const old = { ...addressed, lastSeenAt: new Date(now - 3 * 3600_000).toISOString() }
  expect(headline(old, { state: 'down' })).toEqual(['off', 'Offline'])
})
