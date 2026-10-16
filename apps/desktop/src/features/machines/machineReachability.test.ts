import { expect, it } from 'vitest'
import { machineReachability } from './machineReachability'
import { MACHINE } from './__fixtures__/control'
const now = Date.parse('2026-10-01T00:00:00Z')
const online = {
  ...MACHINE,
  lastSeenAt: new Date(now).toISOString(),
  state: 'running' as const,
  readiness: { pi: 'ok' as const, claude: 'ok' as const, tailscale: 'ok' as const },
}
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
  const addressed = { ...online, endpoint: 'https://host.example:47615' }
  expect(
    machineReachability({ ...addressed, state: 'stopping' }, 'connecting', now).detail,
  ).toContain('stopped or offline')
  expect(machineReachability(addressed, 'down', now + 600_000).detail).toContain(
    'Last seen 10 min ago',
  )
  for (const connection of ['connecting', 'reconnecting'] as const)
    expect(machineReachability(addressed, connection, now).short).toBe('Connecting…')
  expect(machineReachability(addressed, 'down', now).short).toBe('Host offline')
  expect(machineReachability(addressed, 'ready', now).ok).toBe(true)
})
