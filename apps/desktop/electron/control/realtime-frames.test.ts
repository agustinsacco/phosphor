import { expect, it } from 'vitest'
import {
  MACHINES_TOPIC,
  realtimeFrameAction,
  realtimeJoinPayload,
  type RealtimeFrameState,
} from './realtime-frames'

const joined: RealtimeFrameState = { isJoined: true, joinRef: '1', heartbeatRef: '2' }
const joining: RealtimeFrameState = { isJoined: false, joinRef: '1', heartbeatRef: '' }
function frame(
  event: string,
  ref = '',
  topic = MACHINES_TOPIC,
  payload: unknown = { status: 'ok' },
): string {
  return JSON.stringify({ topic, event, ref, payload })
}

it('builds the machine subscription join payload with the supplied token', () => {
  expect(realtimeJoinPayload('secret')).toEqual({
    config: { postgres_changes: [{ event: '*', schema: 'public', table: 'remote_hosts' }] },
    access_token: 'secret',
  })
})

it('accepts exactly 64 KiB and rejects oversized UTF-8 frames', () => {
  const base = frame('postgres_changes', '', MACHINES_TOPIC, { padding: '' })
  const exact = base.replace('"padding":""', `"padding":"${'x'.repeat(65536 - base.length)}"`)
  expect(Buffer.byteLength(exact)).toBe(65536)
  expect(realtimeFrameAction(joined, exact)).toBe('change')
  expect(realtimeFrameAction(joined, exact.replace('xxx', 'xxxx'))).toBe('ignore')
  expect(
    realtimeFrameAction(
      joined,
      frame('postgres_changes', '', MACHINES_TOPIC, { padding: 'é'.repeat(33_000) }),
    ),
  ).toBe('ignore')
})

it.each([
  null,
  new Uint8Array(5),
  '{',
  'null',
  '[]',
  '{}',
  frame('postgres_changes', '', MACHINES_TOPIC, null),
  frame('postgres_changes', '', MACHINES_TOPIC, []),
  frame('postgres_changes', '', MACHINES_TOPIC, 'not-an-object'),
])('ignores malformed or non-text input %#', (data) => {
  expect(realtimeFrameAction(joined, data)).toBe('ignore')
})

it.each(['phx_reply', 'postgres_changes', 'phx_error', 'phx_close'])(
  'ignores %s on an unrelated topic',
  (event) => {
    expect(realtimeFrameAction(joined, frame(event, '1', 'other'))).toBe('ignore')
  },
)

it('requires a nonempty matching join ref and acknowledges a successful join only once', () => {
  expect(realtimeFrameAction(joining, frame('phx_reply', '1'))).toBe('join')
  expect(realtimeFrameAction(joined, frame('phx_reply', '1'))).toBe('ignore')
  expect(realtimeFrameAction(joining, frame('phx_reply', 'wrong'))).toBe('ignore')
  expect(realtimeFrameAction(joining, frame('phx_reply', '1', 'phoenix'))).toBe('ignore')
  expect(realtimeFrameAction({ ...joining, joinRef: '' }, frame('phx_reply'))).toBe('ignore')
  expect(
    realtimeFrameAction(
      joining,
      JSON.stringify({
        topic: MACHINES_TOPIC,
        event: 'phx_reply',
        ref: 1,
        payload: { status: 'ok' },
      }),
    ),
  ).toBe('ignore')
})

it.each([{ status: 'error' }, {}, { status: null }])(
  'reconnects for a matching unsuccessful join reply %j even after joining',
  (payload) => {
    const reply = frame('phx_reply', '1', MACHINES_TOPIC, payload)
    expect(realtimeFrameAction(joining, reply)).toBe('reconnect')
    expect(realtimeFrameAction(joined, reply)).toBe('reconnect')
  },
)

it('accepts only matching successful heartbeat replies while joined', () => {
  const reply = frame('phx_reply', '2', 'phoenix')
  expect(realtimeFrameAction(joined, reply)).toBe('heartbeat')
  expect(realtimeFrameAction({ ...joined, isJoined: false }, reply)).toBe('ignore')
  expect(realtimeFrameAction(joined, frame('phx_reply', 'wrong', 'phoenix'))).toBe('ignore')
  expect(realtimeFrameAction(joined, frame('phx_reply', '2', MACHINES_TOPIC))).toBe('ignore')
  expect(realtimeFrameAction(joined, frame('heartbeat', '2', 'phoenix'))).toBe('ignore')
  expect(realtimeFrameAction(joined, frame('phx_reply', '2', 'phoenix', { status: 'error' }))).toBe(
    'ignore',
  )
  expect(
    realtimeFrameAction({ ...joined, heartbeatRef: '' }, frame('phx_reply', '', 'phoenix')),
  ).toBe('ignore')
})

it('delivers changes only while joined and ignores unknown events', () => {
  expect(realtimeFrameAction(joined, frame('postgres_changes'))).toBe('change')
  expect(realtimeFrameAction(joining, frame('postgres_changes'))).toBe('ignore')
  expect(realtimeFrameAction(joined, frame('unknown'))).toBe('ignore')
})

it.each(['phx_error', 'phx_close'])('reconnects for %s before or after joining', (event) => {
  expect(realtimeFrameAction(joining, frame(event))).toBe('reconnect')
  expect(realtimeFrameAction(joined, frame(event))).toBe('reconnect')
})
