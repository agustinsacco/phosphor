// Previous-release readers. `__fixtures__/base-684cb3478/` holds frozen copies of
// the parsers the agent-control contracts extend. A Host, PWA, Desktop or control
// built at that commit keeps running after this release, in any update order, so
// every frame and body the new code can send must still parse there.
import { describe, expect, it } from 'vitest'
import { parseHeartbeatRequest, parseHeartbeatResponse, parseMachineView } from './control-api'
import { parseGrantPayload, type GrantPayload } from './host-grant'
import { parseLaneSummary } from './host-protocol/host-lanes'
import { parseResultFrame } from './host-protocol/host-receipts'
import { parseReadyFrame } from './host-protocol/host-ready'
import { parseCallFrame, parseCommandFrame } from './host-protocol/client-commands'
import { HOST_FRAMES, CLIENT_FRAMES } from '../test/__fixtures__/protocol-freeze'
import * as base from './__fixtures__/base-684cb3478/host-ready'
import { parseSnapshotFrame } from './host-protocol/host-snapshot'
import * as baseSnapshot from './__fixtures__/base-684cb3478/host-snapshot'
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

  it('preserves conditional take only on the bundled reader; old Hosts would take unconditionally', () => {
    const frame = {
      ...CLIENT_FRAMES.command.unfenced,
      op: { type: 'control.take', ifUnheld: true },
    }
    expect(parseCommandFrame(frame)).toStrictEqual({ ok: true, frame })
    expect(baseCommands.parseCommandFrame(frame)).toStrictEqual({
      ok: true,
      frame: { ...frame, op: { type: 'control.take' } },
    })
    expect(parseCommandFrame({ ...frame, op: { ...frame.op, ifUnheld: false } }).ok).toBe(false)
  })

  it('old readers ignore warm-on-open; current readers retain only booleans', () => {
    const plain = HOST_FRAMES.ready.ready
    for (const warmOnOpen of [true, false]) {
      const frame = { ...plain, warmOnOpen }
      expect(base.parseReadyFrame(frame)).toEqual(parseReadyFrame(plain))
      expect(parseReadyFrame(frame)).toMatchObject({ warmOnOpen })
    }
    expect(parseReadyFrame({ ...plain, warmOnOpen: 'yes' })).toBeNull()
  })

  it('reads commands alike', () => {
    for (const frame of [CLIENT_FRAMES.command.fenced, CLIENT_FRAMES.command.unfenced])
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

describe('frozen 684cb3478 parsers accept the agent-control additions and drop them', () => {
  it('reads a ready frame with every op flag as one without them', () => {
    const { opFlags } = HOST_FRAMES.ready
    const parsed = parseReadyFrame(opFlags)
    expect(parsed).toMatchObject({ ops: true, ownerLocal: true, pagedLanes: false })
    expect(base.parseReadyFrame(opFlags)).toStrictEqual(parseReadyFrame(HOST_FRAMES.ready.ready))
  })

  it('keeps the rewind predecessor lane id only on the new reader', () => {
    const plain = HOST_FRAMES.lanes.lanes.lanes[0]
    const replacement = { ...plain, rewoundFrom: UUID(99) }
    expect(parseLaneSummary(replacement)).toStrictEqual(replacement)
    expect(baseLanes.parseLaneSummary(replacement)).toStrictEqual(parseLaneSummary(plain))
  })

  it('reads a stopped snapshot with recorded composer data on both releases', () => {
    const plain = HOST_FRAMES.snapshot.snapshot
    const stopped = { ...plain, snapshot: { ...plain.snapshot, state: null } }
    const stoppedComposer = {
      model: { provider: 'anthropic', id: 'opus' },
      thinkingLevel: 'high',
      tokens: 72_000,
      contextWindow: 200_000,
    }
    const frame = { ...stopped, snapshot: { ...stopped.snapshot, stoppedComposer } }
    expect(baseSnapshot.parseSnapshotFrame(frame)).toStrictEqual(parseSnapshotFrame(stopped))
    expect(parseSnapshotFrame(frame)?.snapshot.stoppedComposer).toEqual(stoppedComposer)
    expect(
      parseSnapshotFrame({
        ...frame,
        snapshot: {
          ...frame.snapshot,
          stoppedComposer: { tokens: -1, contextWindow: 0, thinkingLevel: 'bad' },
        },
      }),
    ).toEqual(parseSnapshotFrame(stopped))
  })

  it('reads a paused lane summary without its pause', () => {
    // The same summary as the plain `lanes` frame's, plus `pause`.
    const paused = HOST_FRAMES.lanes.paused.lanes[0]
    const plain = HOST_FRAMES.lanes.lanes.lanes[0]
    expect(parseLaneSummary(paused)).toMatchObject({ pause: { reason: 'service-update' } })
    expect(baseLanes.parseLaneSummary(paused)).toStrictEqual(parseLaneSummary(plain))
  })

  it('answers an ops.run command unsupported, never bad-request', () => {
    const frame = CLIENT_FRAMES.command.ops
    expect(parseCommandFrame(frame)).toStrictEqual({ ok: true, frame })
    expect(baseCommands.parseCommandFrame(frame)).toStrictEqual({
      ok: false,
      reason: 'command',
      reply: { kind: 'receipt', requestId: frame.requestId, code: 'unsupported' },
    })
  })

  it('keeps service.pause in an ops.run command and its discovery bit inside opaque result data', () => {
    const frame = {
      ...CLIENT_FRAMES.command.ops,
      op: { type: 'ops.run', op: 'service.pause', args: { action: 'cancel' } },
    }
    expect(parseCommandFrame(frame)).toStrictEqual({ ok: true, frame })
    expect(baseCommands.parseCommandFrame(frame)).toStrictEqual({
      ok: false,
      reason: 'command',
      reply: { kind: 'receipt', requestId: frame.requestId, code: 'unsupported' },
    })
    // host-receipts.ts (including parseResultFrame) is unchanged since 684cb3478.
    const result = {
      type: 'result',
      id: UUID(8),
      ok: true,
      data: {
        status: 'ok',
        text: 'Machine status',
        applies: 'now',
        data: { pause: { kind: 'none' }, update: { pauseControl: true } },
      },
    }
    expect(parseResultFrame(result)).toStrictEqual(result)
  })

  it('negotiates partial catalogue reads without changing the legacy call', () => {
    const ready = HOST_FRAMES.ready.ready
    for (const partialModels of [true, false]) {
      const advertised = { ...ready, partialModels }
      expect(base.parseReadyFrame(advertised)).toStrictEqual(parseReadyFrame(ready))
      expect(parseReadyFrame(advertised)).toMatchObject({ partialModels })
    }
    expect(parseReadyFrame({ ...ready, partialModels: 1 })).toBeNull()
    const frame = { ...CLIENT_FRAMES.call.state, method: 'machine.models', params: {} }
    expect(parseCallFrame(frame)).toStrictEqual({ ok: true, frame })
    expect(baseCommands.parseCallFrame(frame)).toStrictEqual({ ok: true, frame })
  })

  it('admits an ops.run call to its method table, which has no ops.run (unsupported)', () => {
    const frame = {
      ...CLIENT_FRAMES.call.state,
      method: 'ops.run',
      params: { op: 'help', args: {} },
    }
    expect(parseCallFrame(frame)).toStrictEqual({ ok: true, frame })
    expect(baseCommands.parseCallFrame(frame)).toStrictEqual({ ok: true, frame })
  })

  it('reads a machine grant as a user grant with no caps', () => {
    const machine: GrantPayload = { ...BASE_GRANT, caps: [], origin: 'machine', machine: UUID(6) }
    expect(parseGrantPayload(machine)).toStrictEqual({ ok: true, value: machine })
    const { origin: _origin, machine: _machine, ...legacy } = machine
    expect(baseGrant.parseGrantPayload(machine)).toStrictEqual({ ok: true, value: legacy })
  })

  it('reads heartbeats and machines without the reach fields', () => {
    const beat = { ...BASE_BEAT, machineGrants: true }
    expect(parseHeartbeatRequest(beat)).toMatchObject({ ok: true, value: { machineGrants: true } })
    expect(baseMachines.parseHeartbeatRequest(beat)).toStrictEqual(parseHeartbeatRequest(BASE_BEAT))
    const reply = { accepted: true, nextInSec: 30, machineReach: false }
    expect(parseHeartbeatResponse(reply)).toMatchObject({ value: { machineReach: false } })
    expect(baseMachines.parseHeartbeatResponse(reply)).toStrictEqual(
      parseHeartbeatResponse({ accepted: true, nextInSec: 30 }),
    )
    const view = { ...BASE_MACHINE, machineReach: true, machineGrants: false }
    expect(parseMachineView(view)).toMatchObject({ value: { machineReach: true } })
    expect(baseMachines.parseMachineView(view)).toStrictEqual(parseMachineView(BASE_MACHINE))
  })

  it('lists as many machines as the shipped parser reads, and no more', () => {
    const list = (count: number) => ({
      serverTime: '2026-01-01T00:00:00.000Z',
      machines: Array.from({ length: count }, () => BASE_MACHINE),
    })
    // 684cb3478 shipped maxHostsPerAccount 20 and read five times that.
    expect(baseMachines.parseMachinesResponse(list(100)).ok).toBe(true)
    expect(baseMachines.parseMachinesResponse(list(101)).ok).toBe(false)
  })
})

it('older clients accept a stream without its oversized messages; current clients retain the flag', () => {
  const plain = HOST_FRAMES.snapshot.snapshot
  const snapshot = { ...plain.snapshot, messages: [] }
  for (const messagesUnavailable of [true, false]) {
    const frame = { ...plain, snapshot: { ...snapshot, messagesUnavailable } }
    expect(baseSnapshot.parseSnapshotFrame(frame)).toStrictEqual({ ...plain, snapshot })
    expect(parseSnapshotFrame(frame)).toStrictEqual(frame)
  }
  expect(
    parseSnapshotFrame({ ...plain, snapshot: { ...snapshot, messagesUnavailable: 1 } }),
  ).toBeNull()
})

it('both readers accept a summary event carrying stopped composer data', async () => {
  const { parseEventFrame } = await import('./host-protocol/host-snapshot')
  const plain = HOST_FRAMES.event.summary
  const event = { ...plain.event, summary: { ...plain.event.summary, activity: 'stopped' } }
  const stopped = { ...plain, event }
  const stoppedComposer = { tokens: 72_000, contextWindow: 200_000 }
  const frame = { ...stopped, event: { ...event, stoppedComposer } }
  expect(baseSnapshot.parseEventFrame(frame)).toStrictEqual(stopped)
  expect(parseEventFrame(frame)).toStrictEqual(frame)
  expect(parseEventFrame(stopped)).toStrictEqual(stopped)
  expect(
    parseEventFrame({ ...stopped, event: { ...event, stoppedComposer: { tokens: -1 } } }),
  ).toStrictEqual(stopped)
})

it('old readers ignore laneRename; current readers retain only booleans', () => {
  const plain = HOST_FRAMES.ready.ready
  for (const laneRename of [true, false]) {
    const frame = { ...plain, laneRename }
    expect(base.parseReadyFrame(frame)).toEqual(parseReadyFrame(plain))
    expect(parseReadyFrame(frame)).toMatchObject({ laneRename })
  }
  expect(parseReadyFrame({ ...plain, laneRename: 'yes' })).toBeNull()
})
