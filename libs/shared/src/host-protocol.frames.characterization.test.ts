// LS-06 freeze of both public frame parsers before host-protocol.ts is split.
// Every table is keyed by the union it covers (ClientFrame, HostFrame, LaneOp),
// so tsc fails here when a frame type or op type is added without a case.
import { describe, expect, it } from 'vitest'
import {
  HOST_LIMITS,
  parseClientFrame,
  parseHostFrame,
  type ClientFrame,
  type HostFrame,
  type LaneControl,
  type LaneEvent,
  type LaneOp,
  type LaneOpType,
  type LaneSnapshot,
  type LaneSummary,
  type Receipt,
} from './host-protocol'

const LANE = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const REQUEST = '00000000-0000-4000-8000-000000000003'
const TERM = '00000000-0000-4000-8000-000000000004'
const CLIENT = '00000000-0000-4000-8000-000000000005'
const HOST = '00000000-0000-4000-8000-000000000006'
const EPOCH = '0123456789abcdef'
const REPO = 'fedcba9876543210'
const TRACE = '0011223344556677'
const TIME = '2026-01-01T00:00:00.000Z'

const client = (value: unknown) => parseClientFrame(JSON.stringify(value))
const host = (value: unknown) => parseHostFrame(JSON.stringify(value))
const FRAME = { ok: false, reason: 'frame' }
const HOST_FRAME = { ok: false, reason: 'host-frame' }
type ReplyCode = 'bad-request' | 'unsupported'
const receiptReply = (code: ReplyCode) => ({
  ok: false,
  reason: 'command',
  reply: { kind: 'receipt', requestId: REQUEST, code },
})
const CALL_REPLY = {
  ok: false,
  reason: 'call',
  reply: { kind: 'result', id: 'call', code: 'bad-request' },
}

type C<T extends ClientFrame['type']> = Extract<ClientFrame, { type: T }>
type H<T extends HostFrame['type']> = Extract<HostFrame, { type: T }>
/** What a top-level unknown field does: projected away, or the whole frame refused. */
type Extra = 'stripped' | 'rejected'
/** A canonical frame, its unknown-field policy, then at least one malformed input. */
type Variant<F> = readonly [frame: F, extra: Extra, malformed: unknown, ...more: unknown[]]
type Table<F extends { type: string }> = {
  readonly [T in F['type']]: Readonly<Record<string, Variant<Extract<F, { type: T }>>>>
}
const byName = <F, K extends string | number>(names: readonly K[], variant: (k: K) => Variant<F>) =>
  Object.fromEntries(names.map((name) => [String(name), variant(name)] as const))

const AUTH: C<'auth'> = { type: 'auth', grant: 'grant', challenge: 'ab'.repeat(32), trace: TRACE }
const INPUT: C<'terminal.input'> = {
  type: 'terminal.input',
  terminalId: TERM,
  seq: 1,
  data: 'é'.repeat(2048),
}
const AFTER = { epoch: EPOCH, seq: 0 }
const LANES: C<'subscribe'> = { type: 'subscribe', id: 'lanes', topic: 'lanes', after: AFTER }
const LANE_SUB: C<'subscribe'> = {
  type: 'subscribe',
  id: 'l',
  topic: 'lane',
  laneId: LANE,
  trace: TRACE,
}
const TERM_SUB: C<'subscribe'> = {
  type: 'subscribe',
  topic: 'terminal',
  id: 'term.1',
  terminalId: TERM,
}
const COMMAND: C<'command'> = { type: 'command', requestId: REQUEST, op: { type: 'abort' } }
const FENCED: C<'command'> = { ...COMMAND, laneId: LANE, fence: 1, trace: TRACE }
const CALL: C<'call'> = {
  type: 'call',
  id: 'call',
  method: 'lane.state',
  params: { laneId: LANE },
  trace: TRACE,
}
const BARE_CALL: C<'call'> = { type: 'call', id: 'call', method: 'host.repositories.list' }
const PING: C<'ping'> = { type: 'ping', at: Number.MAX_SAFE_INTEGER }

const CLIENT_FRAMES: Table<ClientFrame> = {
  auth: {
    first: [AUTH, 'rejected', { ...AUTH, challenge: 'AB'.repeat(32) }, { ...AUTH, trace: 'bad' }],
    renewal: [{ type: 'auth', grant: 'g'.repeat(4096) }, 'rejected', { type: 'auth', grant: '' }],
  },
  'terminal.input': {
    input: [INPUT, 'rejected', { ...INPUT, seq: 0 }, { ...INPUT, data: 'é'.repeat(2049) }],
  },
  subscribe: {
    lanes: [LANES, 'stripped', { ...LANES, id: 'bad.id' }, { ...LANES, after: null }],
    lane: [LANE_SUB, 'stripped', { ...LANE_SUB, laneId: 'bad' }, { ...LANE_SUB, topic: 'Lane' }],
    terminal: [TERM_SUB, 'rejected', { ...TERM_SUB, trace: TRACE }, { ...TERM_SUB, id: 'term/1' }],
  },
  unsubscribe: {
    unsubscribe: [{ type: 'unsubscribe', id: 'x'.repeat(64) }, 'stripped', { type: 'unsubscribe' }],
  },
  command: {
    fenced: [FENCED, 'stripped', { ...FENCED, requestId: 'bad' }],
    unfenced: [COMMAND, 'stripped', { ...COMMAND, requestId: REQUEST.replace('4000', '4ABC') }],
  },
  'receipt-status': {
    status: [
      { type: 'receipt-status', requestId: REQUEST },
      'stripped',
      { type: 'receipt-status' },
    ],
  },
  call: {
    params: [CALL, 'stripped', { ...CALL, id: 'bad.id' }],
    bare: [BARE_CALL, 'stripped', { ...BARE_CALL, id: 'x'.repeat(65) }],
    'null-params': [{ ...BARE_CALL, params: null }, 'stripped', { ...BARE_CALL, id: '' }],
  },
  ping: {
    ping: [PING, 'stripped', { ...PING, at: -1 }, { ...PING, at: 0.5 }, { ...PING, at: '1' }],
  },
}

/** Refusals that answer with a reply envelope instead of a bare reason. */
const CLIENT_REPLIES: readonly (readonly [input: unknown, output: unknown])[] = [
  [{ ...COMMAND, fence: 0 }, receiptReply('bad-request')],
  [{ ...COMMAND, fence: 1.5 }, receiptReply('bad-request')],
  [{ ...COMMAND, laneId: 'bad' }, receiptReply('bad-request')],
  [{ ...COMMAND, trace: 'bad' }, receiptReply('bad-request')],
  [{ ...COMMAND, op: undefined }, receiptReply('bad-request')],
  [{ ...COMMAND, trace: 'bad', op: { type: 'bash' } }, receiptReply('unsupported')],
  [{ ...CALL, method: 'Lane.state' }, CALL_REPLY],
  [{ ...CALL, method: 'lane.state', trace: 'bad' }, CALL_REPLY],
  [{ ...CALL, method: undefined }, CALL_REPLY],
  [{ ...CALL, method: 'host.repositories.list.all' }, CALL_REPLY],
  [{ ...CALL, method: 'lane.' + 'x'.repeat(60) }, CALL_REPLY],
]

const CONTROL: LaneControl = {
  fence: 2,
  controller: { clientId: CLIENT, label: 'Desktop', connected: false },
}
const SUMMARY: LaneSummary = {
  laneId: LANE,
  repositoryId: REPO,
  cwd: '/home/user/repo',
  title: null,
  branch: 'feature/topic',
  worktree: true,
  model: { provider: 'provider', id: 'model' },
  activity: 'needs-input',
  createdAt: TIME,
  updatedAt: TIME,
  attention: 2,
  read: 2,
  control: CONTROL,
}
const DIALOG = {
  type: 'extension_ui_request',
  id: 'dialog',
  method: 'confirm',
  title: 'Question',
  message: '?',
} as const
const SNAPSHOT: LaneSnapshot = {
  cursor: { epoch: EPOCH, seq: 0 },
  summary: SUMMARY,
  state: null,
  messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
  pending: [{ type: 'agent_start' }],
  dialogs: [DIALOG],
  ui: [{ type: 'extension_ui_request', id: 'title', method: 'setTitle', title: 'Title' }],
}
const CURSOR = { epoch: EPOCH, seq: 1 }
const STREAM = { id: 'term.1', terminalId: TERM, epoch: EPOCH, seq: 1 }
const ACK = { type: 'terminal.ack', terminalId: TERM, seq: 0, accepted: false } as const
const OUTPUT: H<'terminal.output'> = { type: 'terminal.output', ...STREAM, data: 'é'.repeat(8192) }
const RESET = {
  type: 'terminal.reset',
  ...STREAM,
  data: '',
  inputSeq: 0,
  status: 'exited',
} as const
const EXIT: H<'terminal.exit'> = { type: 'terminal.exit', ...STREAM, exitCode: -1 }
const READY: H<'ready'> = {
  type: 'ready',
  protocolVersion: 1,
  hello: {
    hostId: HOST,
    hostVersion: '1.2.3',
    protocolVersion: 1,
    runtimeEpoch: EPOCH,
    capabilities: ['sessions.read', 'terminal'],
  },
  proof: 'A'.repeat(85) + 'w',
  connectionId: EPOCH,
  grantExpiresAt: TIME,
  client: { id: CLIENT, label: 'Desktop' },
  capabilities: ['terminal'],
}
const REPOSITORY = { id: REPO, name: 'repo', path: '/home/user/repo' }
const LANES_FRAME: H<'lanes'> = {
  type: 'lanes',
  id: 'lanes',
  cursor: { epoch: EPOCH, seq: 0 },
  repositories: [REPOSITORY],
  lanes: [SUMMARY],
}
const DELTA = {
  type: 'lanes-delta',
  id: 'l',
  cursor: CURSOR,
  upsert: [SUMMARY],
  remove: [OTHER],
} as const
const ROUTINES: H<'routines-changed'> = { type: 'routines-changed', id: 'routines', cursor: CURSOR }
const attention = (kind: H<'attention'>['event']['kind']): H<'attention'> => ({
  type: 'attention',
  id: 'lanes',
  cursor: CURSOR,
  event: { id: `${LANE}:3`, laneId: LANE, kind, attention: 3, at: TIME, title: 'Lane' },
})
const SNAP = { type: 'snapshot', id: 'l', laneId: LANE, reset: true, snapshot: SNAPSHOT } as const
const LANE_STREAM = { type: 'event', id: 'lane', laneId: LANE, cursor: CURSOR } as const
const laneEvent = (event: LaneEvent): H<'event'> => ({ ...LANE_STREAM, event })
const RESOLVED = { kind: 'dialog-resolved', dialogId: 'dialog' } as const
const receipt = (r: Receipt): H<'receipt'> => ({ type: 'receipt', receipt: r })
const DONE = { requestId: REQUEST, status: 'done' } as const
const REJECTED = { requestId: REQUEST, status: 'rejected', code: 'not-controller' } as const
const failed = (code: 'pi-error' | 'timeout' | 'internal', message = 'm'.repeat(2000)) =>
  receipt({ requestId: REQUEST, status: 'failed', error: { code, message } })
const callError = (code: (H<'result'> & { ok: false })['error']['code'], message = 'failed') =>
  ({ type: 'result', id: 'call', ok: false, error: { code, message } }) as const
const REFUSALS = ['unknown-lane', 'too-many', 'forbidden', 'bad-request', 'too-large'] as const
const CALL_ERRORS = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'too-large',
  'internal',
] as const
const CLOSE_CODES = [1001, 4400, 4401, 4403, 4409, 4429] as const
const KINDS = ['finished', 'needs-input', 'failed', 'routine-finished', 'routine-paused'] as const
const ATTENTION = attention('failed')
const pi = (push: Extract<LaneEvent, { kind: 'pi' }>['push']) => laneEvent({ kind: 'pi', push })

const HOST_FRAMES: Table<HostFrame> = {
  'terminal.ack': { ack: [ACK, 'rejected', { ...ACK, accepted: 1 }, { ...ACK, seq: -1 }] },
  'terminal.output': {
    output: [
      OUTPUT,
      'rejected',
      { ...OUTPUT, data: 'é'.repeat(8193) },
      { ...OUTPUT, epoch: 'bad' },
    ],
  },
  'terminal.reset': { reset: [RESET, 'rejected', { ...RESET, status: 'gone' }] },
  'terminal.exit': { exit: [EXIT, 'rejected', { ...EXIT, exitCode: 0.5 }] },
  ready: {
    ready: [
      READY,
      'stripped',
      { ...READY, protocolVersion: 2 },
      { ...READY, capabilities: ['routines'] },
      { ...READY, proof: 'A'.repeat(85) + 'B' },
      { ...READY, hello: { ...READY.hello, capabilities: ['terminal', 'future'] } },
      { ...READY, hello: { ...READY.hello, hostVersion: ' 1.2.3' } },
    ],
  },
  'auth-renewed': {
    renewed: [
      { type: 'auth-renewed', grantExpiresAt: TIME },
      'stripped',
      { type: 'auth-renewed', grantExpiresAt: '2026-02-30T00:00:00.000Z' },
    ],
  },
  lanes: {
    lanes: [
      LANES_FRAME,
      'stripped',
      { ...LANES_FRAME, repositories: [{}] },
      { ...LANES_FRAME, lanes: [{ ...SUMMARY, read: 3 }] },
    ],
  },
  'lanes-delta': {
    delta: [DELTA, 'stripped', { ...DELTA, cursor: AFTER }, { ...DELTA, remove: ['bad'] }],
  },
  'routines-changed': {
    changed: [ROUTINES, 'rejected', { ...ROUTINES, cursor: AFTER }, { ...ROUTINES, id: 'a.b' }],
  },
  attention: byName(KINDS, (kind) => {
    const frame = attention(kind)
    const wrongId = { ...frame, event: { ...frame.event, id: `${LANE}:2` } }
    return [frame, 'stripped', wrongId, { ...frame, event: { ...frame.event, title: ' x' } }]
  }),
  snapshot: {
    snapshot: [
      SNAP,
      'stripped',
      { ...SNAP, reset: 'yes' },
      { ...SNAP, laneId: OTHER },
      { ...SNAP, snapshot: { ...SNAPSHOT, cursor: null } },
    ],
  },
  event: {
    control: [
      laneEvent({ kind: 'control', control: { fence: 1, controller: null } }),
      'stripped',
      laneEvent({ kind: 'control', control: { fence: 0, controller: null } }),
    ],
    summary: [
      laneEvent({ kind: 'summary', summary: SUMMARY }),
      'stripped',
      laneEvent({ kind: 'summary', summary: { ...SUMMARY, laneId: OTHER } }),
    ],
    'dialog-resolved': [
      laneEvent({ kind: 'dialog-resolved', dialogId: 'dialog' }),
      'stripped',
      laneEvent({ kind: 'dialog-resolved', dialogId: 'bad.id' }),
    ],
    'pi-event': [
      pi({ kind: 'event', event: { type: 'agent_start' } }),
      'stripped',
      { ...pi({ kind: 'event', event: { type: 'agent_start' } }), cursor: AFTER },
    ],
    'pi-extension-ui': [
      pi({ kind: 'extension-ui', request: DIALOG }),
      'stripped',
      pi({ kind: 'extension-ui', request: { ...DIALOG, id: 'bad.id' } }),
    ],
    'pi-exit': [
      pi({ kind: 'exit', code: null, signal: 'SIGTERM', expected: true }),
      'stripped',
      pi({ kind: 'exit', code: -1, signal: null, expected: true }),
    ],
  },
  'subscribe-failed': byName(REFUSALS, (code) => {
    const frame = { type: 'subscribe-failed', id: 'lane', code } as const
    return [frame, 'stripped', { ...frame, code: 'internal' }]
  }),
  receipt: {
    pending: [
      receipt({ requestId: REQUEST, status: 'pending' }),
      'stripped',
      receipt({ ...DONE, requestId: 'x' }),
    ],
    unknown: [
      receipt({ requestId: REQUEST, status: 'unknown' }),
      'stripped',
      { type: 'receipt', receipt: null },
    ],
    done: [
      receipt({ ...DONE, data: [1, 'two', null], fence: 3, laneId: LANE }),
      'stripped',
      receipt({ ...DONE, fence: 0 }),
      receipt({ ...DONE, laneId: 'bad' }),
    ],
    'done-bare': [
      receipt(DONE),
      'stripped',
      { ...receipt(DONE), receipt: { ...DONE, fence: '3' } },
    ],
    'failed-pi-error': [failed('pi-error'), 'stripped', failed('pi-error', 'm'.repeat(2001))],
    'failed-timeout': [failed('timeout'), 'stripped', failed('timeout', '')],
    'failed-internal': [
      failed('internal'),
      'stripped',
      { ...receipt(DONE), receipt: { ...DONE, status: 'failed' } },
    ],
    rejected: [
      receipt({ ...REJECTED, control: CONTROL }),
      'stripped',
      { type: 'receipt', receipt: { ...REJECTED, control: {} } },
      { type: 'receipt', receipt: { ...REJECTED, code: 'gone' } },
    ],
    'rejected-bare': [
      receipt({ ...REJECTED, code: 'branch-exists' }),
      'stripped',
      { type: 'receipt', receipt: { ...REJECTED, control: null } },
    ],
  },
  result: {
    ok: [
      { type: 'result', id: 'call', ok: true, data: { nested: [{ any: 'shape' }] } },
      'stripped',
      { type: 'result', id: 'call', ok: true },
      { type: 'result', id: 'call', ok: 'true', data: 1 },
    ],
    'ok-null': [
      { type: 'result', id: 'call', ok: true, data: null },
      'stripped',
      { type: 'result', id: 'a.b', ok: true, data: null },
    ],
    ...byName(CALL_ERRORS, (code) => [
      callError(code, 'm'.repeat(2000)),
      'stripped',
      callError(code, ''),
      callError(code, 'm'.repeat(2001)),
    ]),
    'error-shape': [
      callError('internal'),
      'stripped',
      { ...callError('internal'), error: 'internal' },
    ],
  },
  error: byName(CLOSE_CODES, (code) => {
    const frame = { type: 'error', code, message: 'closing' } as const
    return [frame, 'stripped', { ...frame, code: String(code) }, { ...frame, message: '' }]
  }),
  pong: {
    pong: [
      { type: 'pong', at: 0 },
      'stripped',
      { type: 'pong', at: -1 },
      { type: 'pong', at: 1e21 },
    ],
  },
}

/** A canonical op and a field patch that invalidates it (null: no field to get wrong). */
type OpCase = readonly [op: LaneOp, bad: object | null]
const IMAGE = { type: 'image', data: 'AA==', mimeType: 'image/webp' } as const
const RESPONSE = { type: 'extension_ui_response', id: 'dialog', confirmed: false } as const
const ROUTINE = {
  name: 'Nightly',
  instructions: 'Run the tests',
  repositoryId: REPO,
  isolated: true,
  intent: 'report',
  provider: 'provider',
  model: 'model',
  timezone: 'UTC',
  schedule: { kind: 'cron', expression: '0 3 * * *' },
  period: 'previous-day',
  catchUpHours: 168,
  maxRuntimeMinutes: 240,
  enabled: true,
  trusted: true,
} as const
const UPLOAD = 'b'.repeat(32)
const WORKTREE = { branch: 'feature/x', fresh: true } as const
const CREATE = {
  type: 'lane.create',
  repositoryId: REPO,
  worktree: WORKTREE,
  name: 'Lane',
} as const
const PROMPT: LaneOp = {
  type: 'prompt',
  message: 'Hi',
  images: [IMAGE],
  streamingBehavior: 'followUp',
}

const OPS = [
  [PROMPT, { streamingBehavior: 'later' }],
  [{ type: 'steer', message: 'Hi', images: [] }, { message: '' }],
  [{ type: 'follow_up', message: 'Hi' }, { images: null }],
  [{ type: 'abort' }, null],
  [{ type: 'abort_retry' }, null],
  [{ type: 'set_model', provider: 'p', modelId: 'm'.repeat(200) }, { modelId: 'm'.repeat(201) }],
  [{ type: 'set_thinking_level', level: 'max' }, { level: 'ultra' }],
  [{ type: 'compact', customInstructions: 'Keep tests' }, { customInstructions: '' }],
  [{ type: 'set_session_name', name: 'Lane' }, { name: ' Lane' }],
  [{ type: 'extension_ui_response', response: RESPONSE }, { response: { ...RESPONSE, value: '' } }],
  [{ ...CREATE, provider: 'p', model: 'm', thinkingLevel: 'off' }, { worktree: { fresh: true } }],
  [{ type: 'lane.resume' }, null],
  [{ type: 'lane.stop' }, null],
  [{ type: 'lane.markRead', upTo: 3 }, { upTo: -1 }],
  [{ type: 'lane.marks', pinned: true, marker: '🦊' }, { marker: 'a\nb' }],
  [
    { type: 'lane.delete', laneId: OTHER, removeWorktree: true, removeBranch: false },
    { laneId: 1 },
  ],
  [{ type: 'control.take' }, null],
  [{ type: 'control.release' }, null],
  [{ type: 'host.repositories.add', path: 'src/repo' }, { path: '../repo' }],
  [{ type: 'host.repositories.remove', repositoryId: REPO }, { repositoryId: 'x' }],
  [{ type: 'host.repositories.createFolder', path: 'src/new' }, { path: '' }],
  [{ type: 'host.repositories.order', repositoryIds: [REPO] }, { repositoryIds: [REPO, REPO] }],
  [{ type: 'provider.login', provider: 'anthropic' }, { provider: '-x' }],
  [{ type: 'machine.task', task: 'claude.installProvider' }, { task: 'bad' }],
  [{ type: 'claude.account', accountId: 'default' }, { accountId: 'bad' }],
  [{ type: 'terminal.create', cols: 2, rows: 1 }, { cols: 1 }],
  [{ type: 'terminal.resize', terminalId: TERM, cols: 1000, rows: 1000 }, { rows: 1001 }],
  [{ type: 'terminal.kill', terminalId: TERM }, { terminalId: 'bad' }],
  [{ type: 'routine.save', routine: ROUTINE, expectedRevision: null }, { expectedRevision: 1 }],
  [{ type: 'routine.run', routineId: OTHER }, { routineId: 'bad' }],
  [{ type: 'routine.cancel', runId: OTHER }, { runId: 'bad' }],
  [{ type: 'routine.skipNext', routineId: OTHER }, { routineId: 1 }],
  [{ type: 'routine.archive', routineId: OTHER }, { routineId: null }],
  [{ type: 'routine.delete', routineId: OTHER }, { routineId: '' }],
  [{ type: 'routine.pauseAll' }, null],
  [{ type: 'files.write', path: 'src/a.ts', content: 'x', expected: null }, { expected: 'x' }],
  [{ type: 'files.create', path: 'src/dir', kind: 'directory' }, { kind: 'link' }],
  [{ type: 'files.rename', from: 'a', to: 'b' }, { to: '../b' }],
  [{ type: 'files.delete', path: 'a' }, { path: '.git' }],
  [{ type: 'files.transfer', source: 'a', directory: '.', mode: 'move' }, { mode: 'link' }],
  [{ type: 'attachments.begin', name: 'a.png', size: 3, mime: 'image/png' }, { size: -1 }],
  [{ type: 'attachments.chunk', uploadId: UPLOAD, index: 0, data: 'AAAA' }, { data: '' }],
  [{ type: 'attachments.commit', uploadId: UPLOAD, sha256: 'c'.repeat(64) }, { sha256: 'x' }],
] satisfies readonly OpCase[]
/** Compile-time exhaustiveness: this fails to type-check when LaneOp gains an op type. */
const everyOpType: Record<Exclude<LaneOpType, (typeof OPS)[number][0]['type']>, never> = {}
/** Families whose parsers allow exactly their own keys, so an unknown field refuses the op. */
const EXACT_KEY_OPS =
  /^(lane\.delete|lane\.marks|claude\.account|machine\.|host\.repositories\.|provider\.|terminal\.|routine\.|files\.|attachments\.)/
/** Families absent from the receipt-code allowlist: an invalid one is unsupported, not bad-request. */
const UNLISTED_OPS = /^(files|attachments)\./
/** Families that never carry a lane id or fence. */
const LANELESS_OPS = /^(host\.repositories|provider|routine|machine)\./

const rows = (table: Readonly<Record<string, Readonly<Record<string, Variant<object>>>>>) =>
  Object.entries(table).flatMap(([type, variants]) =>
    Object.entries(variants).map(([name, [frame, extra, ...malformed]]) => ({
      type,
      name,
      frame,
      extra,
      malformed,
    })),
  )
const clientRows = rows(CLIENT_FRAMES)
const hostRows = rows(HOST_FRAMES)
const opRows = Object.values(OPS).map(([op, bad]) => ({
  type: op.type,
  op,
  bad,
  exact: EXACT_KEY_OPS.test(op.type),
  code: UNLISTED_OPS.test(op.type) ? ('unsupported' as const) : ('bad-request' as const),
  laneless: LANELESS_OPS.test(op.type),
}))
const command = (op: unknown, fields: object = {}) =>
  client({ type: 'command', requestId: REQUEST, op, ...fields })
const accepted = (op: unknown, fields: object = {}) => ({
  ok: true,
  frame: { type: 'command', requestId: REQUEST, op, ...fields },
})

const piFrame = (push: unknown) => ({ ...laneEvent(RESOLVED), event: { kind: 'pi', push } })
const ok = (value: unknown) => ({ ok: true, value })
const X = { unknown: 'secret' }

describe('parseClientFrame frame matrix', () => {
  it.each(clientRows)('accepts $type ($name) unchanged', ({ frame }) => {
    expect(client(frame)).toStrictEqual({ ok: true, frame })
  })
  it.each(clientRows)('$type ($name): an unknown top-level field is $extra', ({ frame, extra }) => {
    expect(client({ ...frame, ...X })).toStrictEqual(
      extra === 'stripped' ? { ok: true, frame } : FRAME,
    )
  })
  it.each(clientRows)('refuses malformed $type ($name) with a bare reason', ({ malformed }) => {
    for (const input of malformed) expect(client(input)).toStrictEqual(FRAME)
  })
  it('answers refused commands and calls with exact reply envelopes', () => {
    for (const [input, output] of CLIENT_REPLIES) expect(client(input)).toStrictEqual(output)
    expect(client({ ...LANES, after: { ...AFTER, ...X } })).toStrictEqual({
      ok: true,
      frame: LANES,
    })
  })
})

describe('parseClientFrame operation families', () => {
  it('covers every LaneOp type exactly once', () => {
    expect(everyOpType).toStrictEqual({})
    expect(new Set(opRows.map((row) => row.type)).size).toBe(opRows.length)
  })
  it.each(opRows)('accepts command op $type unchanged', ({ op }) => {
    const fields = op.type === 'claude.account' ? { laneId: LANE, fence: 7 } : {}
    expect(command(op, fields)).toStrictEqual(accepted(op, fields))
  })
  it.each(opRows)(
    'command op $type: an unknown field refuses it: $exact',
    ({ op, exact, code }) => {
      expect(command({ ...op, ...X })).toStrictEqual(exact ? receiptReply(code) : accepted(op))
    },
  )
  it.each(opRows)('refuses an invalid command op $type as $code', ({ op, bad, code }) => {
    if (bad) expect(command({ ...op, ...bad })).toStrictEqual(receiptReply(code))
  })
  it.each(opRows)('command op $type with a lane id or fence (laneless: $laneless)', (row) => {
    for (const fields of [{ laneId: LANE }, { fence: 7 }, { laneId: LANE, fence: 7 }]) {
      const refused = receiptReply('bad-request')
      expect(command(row.op, fields)).toStrictEqual(
        row.laneless ||
          (row.op.type === 'claude.account' && (!('laneId' in fields) || !('fence' in fields)))
          ? refused
          : accepted(row.op, fields),
      )
    }
  })
  it('classifies unknown op types as unsupported and shapeless ops as bad-request', () => {
    const unknown = ['bash', 'get_state', 'Prompt', 'files.list', 'terminal.input', 'routine.list']
    for (const type of [...unknown, 'host.repositories.list', 'attachments.abort', 'lane.rename'])
      expect(command({ type }), type).toStrictEqual(receiptReply('unsupported'))
    for (const op of [null, [], 'prompt', 1, {}, { type: 1 }, [{ type: 'abort' }]])
      expect(command(op), JSON.stringify(op)).toStrictEqual(receiptReply('bad-request'))
  })
  it('projects nested op fields, trims routine text and needs one exclusive UI answer', () => {
    const answer = (response: object) => ({ type: 'extension_ui_response', response })
    expect(command(answer({ ...RESPONSE, ...X }))).toStrictEqual(accepted(answer(RESPONSE)))
    const prompt = { type: 'prompt', message: 'Hi' }
    const images = { ...prompt, images: [{ ...IMAGE, ...X }] }
    expect(command(images)).toStrictEqual(accepted({ ...prompt, images: [IMAGE] }))
    const worktree = { branch: 'b' }
    expect(command({ ...CREATE, worktree: { ...worktree, ...X } })).toStrictEqual(
      accepted({ ...CREATE, worktree }),
    )
    const schedule = { kind: 'cron', expression: ' 0 3 * * * ' }
    const padded = { ...ROUTINE, name: '  Nightly ', provider: ' provider ', schedule }
    const save = { type: 'routine.save', routineId: OTHER, expectedRevision: 4 }
    expect(command({ ...save, routine: padded })).toStrictEqual(
      accepted({ ...save, routine: ROUTINE }),
    )
    for (const fields of [{ value: '' }, { cancelled: true }, { confirmed: true }]) {
      const response = { type: RESPONSE.type, id: 'd', ...fields }
      expect(command(answer(response))).toStrictEqual(accepted(answer(response)))
    }
    for (const fields of [{}, { value: 1 }, { cancelled: false }, { value: 'a', confirmed: true }])
      expect(command(answer({ ...RESPONSE, confirmed: undefined, ...fields }))).toStrictEqual(
        receiptReply('bad-request'),
      )
  })
})

describe('parseHostFrame frame matrix', () => {
  it.each(hostRows)('accepts $type ($name) unchanged', ({ frame }) => {
    expect(host(frame)).toStrictEqual(ok(frame))
  })
  it.each(hostRows)('$type ($name): an unknown top-level field is $extra', ({ frame, extra }) => {
    expect(host({ ...frame, ...X })).toStrictEqual(extra === 'stripped' ? ok(frame) : HOST_FRAME)
  })
  it.each(hostRows)('refuses malformed $type ($name)', ({ malformed }) => {
    for (const input of malformed) expect(host(input)).toStrictEqual(HOST_FRAME)
  })
  it('projects away unknown nested fields outside pi payloads', () => {
    const control = { ...CONTROL, ...X, controller: { ...CONTROL.controller, ...X } }
    const summary = {
      ...SUMMARY,
      ...X,
      model: { provider: 'provider', id: 'model', ...X },
      control,
    }
    const lanes = {
      ...LANES_FRAME,
      cursor: { ...AFTER, ...X },
      repositories: [{ ...REPOSITORY, ...X }],
    }
    const failure = failed('timeout')
    const error = { code: 'timeout', message: 'm'.repeat(2000), ...X }
    const rejected = receipt({ ...REJECTED, control: CONTROL })
    const exit = { kind: 'exit', code: 0, signal: null, expected: false }
    const cases = [
      [{ ...lanes, lanes: [summary] }, LANES_FRAME],
      [{ ...READY, hello: { ...READY.hello, ...X }, client: { ...READY.client, ...X } }, READY],
      [{ ...SNAP, snapshot: { ...SNAPSHOT, ...X, summary } }, SNAP],
      [{ ...ATTENTION, event: { ...ATTENTION.event, ...X } }, ATTENTION],
      [{ ...failure, receipt: { ...failure.receipt, ...X, error } }, failure],
      [{ ...rejected, receipt: { ...REJECTED, control } }, rejected],
      [
        { ...callError('internal'), error: { code: 'internal', message: 'failed', ...X } },
        callError('internal'),
      ],
      [
        { ...laneEvent(RESOLVED), event: { kind: 'summary', summary } },
        laneEvent({ kind: 'summary', summary: SUMMARY }),
      ],
      [piFrame({ ...exit, ...X }), piFrame(exit)],
    ] as const
    for (const [input, value] of cases) expect(host(input)).toStrictEqual(ok(value))
  })
  it('passes pi payloads through shallowly, keeping their unknown fields', () => {
    const message = { role: 'future', content: { deep: [1, { x: null }] }, extra: true }
    const event = { type: 'future_event', payload: { nested: [1] } }
    const dialog = { ...DIALOG, method: 'future', extra: { a: 1 } }
    const state = { anything: [1, 2], nested: { deep: true } }
    const piState = { state, messages: [message], pending: [event], dialogs: [dialog], ui: [] }
    const snapshot = { ...SNAP, snapshot: { ...SNAPSHOT, ...piState } }
    expect(host(snapshot)).toStrictEqual(ok(snapshot))
    for (const push of [
      { kind: 'event', event },
      { kind: 'extension-ui', request: dialog },
    ])
      expect(host(piFrame({ ...push, ...X }))).toStrictEqual(ok(piFrame(push)))
    const invalid = [{ state: [] }, { messages: [{}] }, { pending: [{}] }, { dialogs: [{}] }]
    for (const patch of invalid)
      expect(host({ ...SNAP, snapshot: { ...SNAPSHOT, ...patch } })).toStrictEqual(HOST_FRAME)
    const unforwarded = [{ kind: 'stderr', text: 'secret' }, { kind: 'resync' }]
    for (const push of [...unforwarded, { kind: 'event', event: { type: 1 } }])
      expect(host(piFrame(push))).toStrictEqual(HOST_FRAME)
  })
  it('caps snapshot UI state per kind and refuses non-state UI requests', () => {
    const ui = (method: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ type: DIALOG.type, id: `${method}${i}`, method }))
    const withUi = (items: unknown[]) => ({ ...SNAP, snapshot: { ...SNAPSHOT, ui: items } })
    const full = [...ui('setStatus', 64), ...ui('setWidget', 32), ...ui('setTitle', 1)]
    expect(host(withUi(full))).toStrictEqual(ok(withUi(full)))
    const over = [[...full, ...ui('setTitle', 1)], ui('setStatus', 65), ui('setWidget', 33)]
    for (const items of [...over, ui('setTitle', 2), ui('confirm', 1), ui('notify', 1)])
      expect(host(withUi(items))).toStrictEqual(HOST_FRAME)
  })
})

describe('frame envelopes and byte limits', () => {
  it('reports read failures and unknown types with exact reasons from both parsers', () => {
    for (const parse of [parseClientFrame, parseHostFrame]) {
      for (const text of ['', '{', '{"type":"ping",}'])
        expect(parse(text)).toStrictEqual({ ok: false, reason: 'json' })
      for (const text of ['null', '[]', '1', '"ping"', 'true'])
        expect(parse(text)).toStrictEqual({ ok: false, reason: 'object' })
    }
    for (const type of [undefined, 'pong', 'ready', 'PING', 'terminal.ack'])
      expect(client({ type, at: 1 })).toStrictEqual({ ok: false, reason: 'type' })
    for (const type of [undefined, 'ping', 'auth', 'PONG', 'terminal.input'])
      expect(host({ type, at: 1 })).toStrictEqual(HOST_FRAME)
  })
  it('bounds both parsers by exact UTF-8 bytes, counting a lone surrogate as three', () => {
    // 1000 lone surrogates (3 bytes), 1000 two-byte and 1000 four-byte characters: 9000 bytes.
    const fill = '\ud800'.repeat(1000) + 'é'.repeat(1000) + '😀'.repeat(1000)
    const padded = (type: string, limit: number) => {
      const head = `{"type":"${type}","at":0,"pad":"`
      return head + fill + 'x'.repeat(limit - head.length - 9000 - 2) + '"}'
    }
    const inbound = padded('ping', HOST_LIMITS.inboundFrameBytes)
    expect(parseClientFrame(inbound)).toStrictEqual({ ok: true, frame: { type: 'ping', at: 0 } })
    expect(parseClientFrame(inbound + ' ')).toStrictEqual({ ok: false, reason: 'frame-size' })
    const outbound = padded('pong', HOST_LIMITS.outboundFrameBytes)
    expect(parseHostFrame(outbound)).toStrictEqual(ok({ type: 'pong', at: 0 }))
    expect(parseHostFrame(outbound + ' ')).toStrictEqual({ ok: false, reason: 'frame-size' })
  })
  it('refuses receipt data over its byte limit or too deep to serialize, never result data', () => {
    const half = (HOST_LIMITS.receiptDataBytes - 2) / 2
    const data = receipt({ ...DONE, data: 'é'.repeat(half) })
    expect(host(data)).toStrictEqual(ok(data))
    expect(host(receipt({ ...DONE, data: 'é'.repeat(half) + 'x' }))).toStrictEqual(HOST_FRAME)
    const nested = (depth: number) => '['.repeat(depth) + ']'.repeat(depth)
    const done = (data: string) =>
      `{"type":"receipt","receipt":{"requestId":"${REQUEST}","status":"done","data":${data}}}`
    expect(parseHostFrame(done(nested(100))).ok).toBe(true)
    expect(parseHostFrame(done(nested(100_000)))).toStrictEqual(HOST_FRAME)
    const result = `{"type":"result","id":"call","ok":true,"data":${nested(100_000)}}`
    expect(parseHostFrame(result).ok).toBe(true)
    const call = `{"type":"call","id":"c","method":"a.b","params":${nested(100_000)}}`
    expect(parseClientFrame(call).ok).toBe(true)
  })
  it('answers generated hostile inputs with exact results', () => {
    for (let i = 0; i < 64; i++) {
      const open = '{"type":"receipt","receipt":' + '['.repeat(i)
      for (const parse of [parseClientFrame, parseHostFrame])
        expect(parse(open)).toStrictEqual({ ok: false, reason: 'json' })
      const proto = `{"__proto__":{"type":"ping","at":${i}},"constructor":${i}}`
      expect(parseClientFrame(proto)).toStrictEqual({ ok: false, reason: 'type' })
      expect(parseHostFrame(proto)).toStrictEqual(HOST_FRAME)
      const lone = `{"type":"ping","at":${i},"pad":"${'\udc00'.repeat(i)}"}`
      expect(parseClientFrame(lone)).toStrictEqual({ ok: true, frame: { type: 'ping', at: i } })
    }
  })
})
