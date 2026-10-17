import type { TrafficEntry, TrafficPage } from '@shared/ipc'
import { MOCK_HOST_ID } from './mockRemoteLanes'

/** A plausible stream of Host and control traffic for the browser harness's debug log. */
const SCRIPT: Omit<TrafficEntry, 'seq' | 'at'>[] = [
  { peer: 'control', direction: 'call', kind: 'GET /v1/machines', ms: 84, outcome: 'ok' },
  { peer: 'host', hostId: MOCK_HOST_ID, direction: 'out', kind: 'ping', bytes: 24 },
  { peer: 'host', hostId: MOCK_HOST_ID, direction: 'in', kind: 'pong', bytes: 24, ms: 31 },
  {
    peer: 'host',
    hostId: MOCK_HOST_ID,
    direction: 'out',
    kind: 'call',
    detail: 'machine.providers',
    bytes: 96,
  },
  {
    peer: 'host',
    hostId: MOCK_HOST_ID,
    direction: 'in',
    kind: 'result',
    detail: 'machine.providers',
    bytes: 412,
    ms: 46,
    outcome: 'ok',
  },
  {
    peer: 'host',
    hostId: MOCK_HOST_ID,
    direction: 'in',
    kind: 'event',
    detail: 'message_update · 7f3a9c21',
    bytes: 1830,
  },
  {
    peer: 'host',
    hostId: MOCK_HOST_ID,
    direction: 'in',
    kind: 'result',
    detail: 'machine.claude',
    bytes: 88,
    ms: 1204,
    outcome: 'error',
    code: 'timeout',
  },
]

let seq = 0
let started = 0
const entries: TrafficEntry[] = []

export function mockTraffic(after: number): TrafficPage {
  const now = Date.now()
  if (!started) started = now - 3000
  // About two entries a second since the first read.
  while (started + seq * 500 <= now) {
    const next = SCRIPT[seq % SCRIPT.length]!
    seq += 1
    entries.push({ ...next, seq, at: started + seq * 500 })
  }
  entries.splice(0, Math.max(0, entries.length - 2000))
  const first = entries[0]?.seq ?? 0
  return { entries: entries.filter((e) => e.seq > after), last: seq, gap: after < first - 1 }
}
