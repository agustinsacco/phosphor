// Previous-release readers. `__fixtures__/base-684cb3478/` holds frozen copies of
// the parsers the agent-control contracts extend. A Host, PWA, Desktop or control
// built at that commit keeps running after this release, in any update order, so
// every frame and body the new code can send must still parse there.
import { describe, expect, it } from 'vitest'
import { parseHeartbeatRequest, parseHeartbeatResponse, parseMachineView } from './control-api'
import { parseGrantPayload, type GrantPayload } from './host-grant'
import { parseLaneSummary } from './host-protocol/host-lanes'
import { parseReadyFrame } from './host-protocol/host-ready'
import { parseCommandFrame } from './host-protocol/client-commands'
import { HOST_FRAMES, CLIENT_FRAMES } from '../test/__fixtures__/protocol-freeze'
import * as base from './__fixtures__/base-684cb3478/host-ready'
import * as baseLanes from './__fixtures__/base-684cb3478/host-lanes'
import * as baseCommands from './__fixtures__/base-684cb3478/client-commands'
import * as baseGrant from './__fixtures__/base-684cb3478/host-grant'
import * as baseMachines from './__fixtures__/base-684cb3478/control-api-machines'

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BASE_GRANT: GrantPayload = {
  v: 1,
  iss: 'https://control.example',
  kid: 'key',
  sub: UUID(1),
  sid: UUID(2),
  hostId: UUID(3),
  epoch: 1,
  client: { id: UUID(4), label: 'Viewer' },
  caps: ['sessions.read'],
  iat: 1000,
  exp: 1300,
  jti: '0123456789abcdef',
}
const BASE_BEAT = {
  seq: 1,
  state: 'running',
  hostVersion: '1.0.0',
  uptimeSec: 1,
  readiness: { pi: 'ok', claude: 'ok', tailscale: 'ok' },
  lanes: { running: 0, waiting: 0 },
  endpoint: null,
}
const BASE_MACHINE = {
  id: UUID(5),
  label: 'stark',
  hostname: 'stark',
  platform: 'linux',
  arch: 'x64',
  hostVersion: '1.0.0',
  keyFingerprint: '0011-2233-4455-6677',
  enrolledAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: null,
  state: null,
  readiness: null,
  lanes: null,
  endpoint: null,
}

describe('frozen 684cb3478 parsers agree with today on frames both releases send', () => {
  it('reads the ready frame and lane summaries alike', () => {
    const ready = HOST_FRAMES.ready.ready
    expect(base.parseReadyFrame(ready)).toStrictEqual(parseReadyFrame(ready))
    const summary = HOST_FRAMES.lanes.lanes.lanes[0]
    expect(baseLanes.parseLaneSummary(summary)).toStrictEqual(parseLaneSummary(summary))
  })

  it('reads commands alike', () => {
    for (const frame of Object.values(CLIENT_FRAMES.command))
      expect(baseCommands.parseCommandFrame(frame)).toStrictEqual(parseCommandFrame(frame))
  })

  it('reads grants, heartbeats and machines alike', () => {
    expect(baseGrant.parseGrantPayload(BASE_GRANT)).toStrictEqual(parseGrantPayload(BASE_GRANT))
    expect(baseMachines.parseHeartbeatRequest(BASE_BEAT)).toStrictEqual(
      parseHeartbeatRequest(BASE_BEAT),
    )
    const reply = { accepted: true, nextInSec: 30 }
    expect(baseMachines.parseHeartbeatResponse(reply)).toStrictEqual(parseHeartbeatResponse(reply))
    expect(baseMachines.parseMachineView(BASE_MACHINE)).toStrictEqual(
      parseMachineView(BASE_MACHINE),
    )
    expect(parseMachineView(BASE_MACHINE).ok).toBe(true)
    expect(parseHeartbeatRequest(BASE_BEAT).ok).toBe(true)
  })
})
