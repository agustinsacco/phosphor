import type { MachineView, EnrollmentLookupResponse } from '@shared/control-api'

export const MACHINE: MachineView = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'bee1',
  hostname: 'bee1',
  platform: 'linux',
  arch: 'x64',
  hostVersion: '0.2.0',
  keyFingerprint: '0123-4567-89ab-cdef',
  enrolledAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: null,
  state: null,
  readiness: { pi: 'ok', claude: 'signed-out', tailscale: 'ok' },
  lanes: { running: 2, waiting: 1 },
  endpoint: null,
}
export const LOOKUP: EnrollmentLookupResponse = {
  hostname: MACHINE.hostname,
  platform: MACHINE.platform,
  arch: MACHINE.arch,
  hostVersion: '0.2.0',
  keyFingerprint: MACHINE.keyFingerprint,
  expiresAt: '2026-01-01T00:10:00.000Z',
}
