// Freezes the Host protocol's frame discriminants. Baselines are literal
// values, never snapshots, so no update flag can rewrite them. Acceptance here
// is shape only: grants, proofs and authorization stay with the conformance
// suite (libs/shared/src/host-protocol-testing/conformance.ts).
import { describe, expect, it } from 'vitest'
import {
  parseClientFrame,
  parseHostFrame,
  type ClientFrame,
  type HostFrame,
} from '@phosphor/shared/host-protocol'
import {
  CLIENT_FRAMES,
  HOST_FRAMES,
  LANE_PI_PUSHES,
  REQUEST_ID,
  frameCases,
  laneEventFrame,
} from './__fixtures__/protocol-freeze'

const clientCases = frameCases<ClientFrame>(CLIENT_FRAMES)
const hostCases = frameCases<HostFrame>(HOST_FRAMES)
const client = (value: unknown) => parseClientFrame(JSON.stringify(value))
const host = (value: unknown) => parseHostFrame(JSON.stringify(value))
/** Discriminant values that no frame union has, or only differ by case or spacing. */
const unknownTypes = [
  undefined,
  null,
  42,
  true,
  '',
  ' ',
  'constructor',
  'toString',
  '__proto__',
  'hasOwnProperty',
  'terminal.',
  'terminal.unknown',
  'subscribe.lanes',
]

describe('client frame discriminants', () => {
  it('pins every ClientFrame type and subscribe topic', () => {
    expect(Object.keys(CLIENT_FRAMES).sort()).toStrictEqual([
      'auth',
      'call',
      'command',
      'ping',
      'receipt-status',
      'subscribe',
      'terminal.input',
      'unsubscribe',
    ])
    expect(Object.keys(CLIENT_FRAMES.subscribe).sort()).toStrictEqual(['lane', 'lanes', 'terminal'])
  })

  it.each(clientCases)('parseClientFrame accepts $type ($variant)', ({ type, frame }) => {
    const parsed = client(frame)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.frame.type).toBe(type)
  })

  it('keeps each subscribe topic as its own variant', () => {
    for (const [topic, frame] of Object.entries(CLIENT_FRAMES.subscribe))
      expect(client(frame)).toMatchObject({ ok: true, frame: { type: 'subscribe', topic } })
  })

  it('rejects unknown and Host-only frame kinds by type', () => {
    const kinds = [...unknownTypes, 'AUTH', 'Ping', 'ping ', 'auth\u0000', 'ready', 'pong']
    for (const type of kinds)
      expect(client({ type, at: 1 }), String(type)).toStrictEqual({ ok: false, reason: 'type' })
  })

  it('rejects unknown subscribe topics', () => {
    for (const topic of [undefined, null, '', 'Lanes', 'lanes ', 'terminals', 'routines', 'host'])
      expect(client({ ...CLIENT_FRAMES.subscribe.lanes, topic }), String(topic)).toStrictEqual({
        ok: false,
        reason: 'frame',
      })
  })

  it.each(hostCases)('parseClientFrame rejects Host frame $type ($variant)', ({ frame }) => {
    expect(client(frame)).toStrictEqual({ ok: false, reason: 'type' })
  })
})

describe('Host frame discriminants', () => {
  it('pins every HostFrame type and its variant keys', () => {
    expect(Object.keys(HOST_FRAMES).sort()).toStrictEqual([
      'attention',
      'auth-renewed',
      'error',
      'event',
      'lanes',
      'lanes-delta',
      'pong',
      'ready',
      'receipt',
      'result',
      'routines-changed',
      'snapshot',
      'subscribe-failed',
      'terminal.ack',
      'terminal.exit',
      'terminal.output',
      'terminal.reset',
    ])
    expect(Object.keys(HOST_FRAMES.event).sort()).toStrictEqual([
      'control',
      'dialog-resolved',
      'pi',
      'summary',
    ])
    expect(Object.keys(LANE_PI_PUSHES).sort()).toStrictEqual(['event', 'exit', 'extension-ui'])
    expect(Object.keys(HOST_FRAMES.receipt).sort()).toStrictEqual([
      'done',
      'failed',
      'pending',
      'rejected',
      'unknown',
    ])
    expect(Object.keys(HOST_FRAMES.result).sort()).toStrictEqual(['error', 'ok'])
  })

  it.each(hostCases)('parseHostFrame accepts $type ($variant)', ({ type, frame }) => {
    const parsed = host(frame)
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.value.type).toBe(type)
  })

  it('accepts every lane event kind, pi push kind, receipt status and result outcome', () => {
    for (const [kind, frame] of Object.entries(HOST_FRAMES.event))
      expect(host(frame)).toMatchObject({ ok: true, value: { type: 'event', event: { kind } } })
    for (const [kind, push] of Object.entries(LANE_PI_PUSHES))
      expect(host(laneEventFrame({ kind: 'pi', push }))).toMatchObject({
        ok: true,
        value: { event: { kind: 'pi', push: { kind } } },
      })
    for (const [status, frame] of Object.entries(HOST_FRAMES.receipt))
      expect(host(frame)).toMatchObject({ ok: true, value: { receipt: { status } } })
    expect(host(HOST_FRAMES.result.ok)).toMatchObject({ ok: true, value: { ok: true } })
    expect(host(HOST_FRAMES.result.error)).toMatchObject({ ok: true, value: { ok: false } })
  })

  it('rejects unknown and client-only frame kinds by type', () => {
    const rejected = { ok: false, reason: 'host-frame' }
    const kinds = [...unknownTypes, 'READY', 'Pong', 'pong ', 'auth', 'ping', 'terminal.input']
    for (const type of kinds) {
      expect(host({ type, at: 1 }), String(type)).toStrictEqual(rejected)
      expect(host({ ...HOST_FRAMES['terminal.output'].output, type }), String(type)).toStrictEqual(
        rejected,
      )
    }
  })

  it('rejects unknown lane event kinds, unforwarded pi pushes and unknown receipt statuses', () => {
    const rejected = { ok: false, reason: 'host-frame' }
    for (const kind of ['unknown', 'Pi', 'resync', 'stderr'])
      expect(
        host({ ...HOST_FRAMES.event['dialog-resolved'], event: { kind, dialogId: 'dialog' } }),
      ).toStrictEqual(rejected)
    // A Desktop session push that the lane stream never forwards.
    for (const push of [{ kind: 'stderr', text: 'secret' }, { kind: 'resync' }, { kind: 'x' }])
      expect(host({ ...HOST_FRAMES.event.pi, event: { kind: 'pi', push } })).toStrictEqual(rejected)
    for (const status of ['unknown ', 'Done', 'accepted', 'cancelled', undefined])
      expect(host({ type: 'receipt', receipt: { requestId: REQUEST_ID, status } })).toStrictEqual(
        rejected,
      )
    for (const ok of ['true', 1, null, undefined])
      expect(host({ ...HOST_FRAMES.result.ok, ok })).toStrictEqual(rejected)
  })

  it.each(clientCases)('parseHostFrame rejects client frame $type ($variant)', ({ frame }) => {
    expect(host(frame)).toStrictEqual({ ok: false, reason: 'host-frame' })
  })
})
