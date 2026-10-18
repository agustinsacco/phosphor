/**
 * One valid frame for every discriminant of the Host protocol's frame unions.
 *
 * Frame kinds are erased types with no runtime enum, so these maps hold both
 * halves of the freeze: `satisfies` makes tsc fail when a union gains or loses
 * a member, and the freeze tests feed every frame to the public parsers so a
 * parser that stops accepting one fails at runtime. Each value is canonical:
 * it parses back to itself. Shapes only; grants, proofs and fences are not
 * verified here (the Host conformance suite owns those semantics).
 */
import type {
  ClientFrame,
  HostFrame,
  LaneControl,
  LaneEvent,
  LaneOpType,
  LanePiPush,
  LaneSnapshot,
  LaneSummary,
  Receipt,
} from '@phosphor/shared/host-protocol'
import type { ExtensionUIRequest } from '@phosphor/shared/rpc'

export const LANE_ID = '00000000-0000-4000-8000-00000000000a'
export const OTHER_LANE_ID = '00000000-0000-4000-8000-00000000000b'
export const CLIENT_ID = '00000000-0000-4000-8000-00000000000c'
export const HOST_ID = '00000000-0000-4000-8000-00000000000d'
export const REQUEST_ID = '00000000-0000-4000-8000-00000000000e'
export const TERMINAL_ID = '00000000-0000-4000-8000-00000000000f'
export const EPOCH = '0123456789abcdef'
export const REPOSITORY_ID = 'fedcba9876543210'
export const TRACE = '0011223344556677'
export const TIME = '2026-01-01T00:00:00.000Z'
/** Any string within the size limit; the frame parser never verifies a grant. */
export const GRANT = 'phosphor-grant.v1.fixture.signature'
export const CHALLENGE = 'ab'.repeat(32)

const CONTROL: LaneControl = {
  fence: 1,
  controller: { clientId: CLIENT_ID, label: 'Desktop', connected: true },
}
const SUMMARY: LaneSummary = {
  laneId: LANE_ID,
  repositoryId: REPOSITORY_ID,
  cwd: '/home/user/repo',
  title: 'Lane',
  branch: 'main',
  worktree: false,
  model: { provider: 'provider', id: 'model' },
  activity: 'idle',
  createdAt: TIME,
  updatedAt: TIME,
  attention: 1,
  read: 0,
  control: CONTROL,
}
const DIALOG: ExtensionUIRequest = {
  type: 'extension_ui_request',
  id: 'dialog',
  method: 'confirm',
  title: 'Question',
  message: 'Continue?',
}
const SNAPSHOT: LaneSnapshot = {
  cursor: { epoch: EPOCH, seq: 0 },
  summary: SUMMARY,
  state: null,
  messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
  pending: [{ type: 'agent_start' }],
  dialogs: [DIALOG],
  ui: [
    {
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey: 'key',
      statusText: 'text',
    },
  ],
}

type FrameOf<F extends { type: string }, T extends F['type']> = Extract<F, { type: T }>
type SubscribeFrame = FrameOf<ClientFrame, 'subscribe'>
type EventFrame = FrameOf<HostFrame, 'event'>
type ReceiptFrame = FrameOf<HostFrame, 'receipt'>
type ResultFrame = FrameOf<HostFrame, 'result'>

/** Every member of `F`, grouped by its `type`; each group is keyed by a variant name. */
export type FramesByType<F extends { type: string }> = {
  readonly [T in F['type']]: Readonly<Record<string, FrameOf<F, T>>>
}

/** pi pushes a lane `event` frame may carry, keyed by push kind. */
export const LANE_PI_PUSHES = {
  event: { kind: 'event', event: { type: 'agent_start' } },
  'extension-ui': { kind: 'extension-ui', request: DIALOG },
  exit: { kind: 'exit', code: 1, signal: null, expected: false },
} satisfies { readonly [K in LanePiPush['kind']]: Extract<LanePiPush, { kind: K }> }

export function laneEventFrame<E extends LaneEvent>(event: E): EventFrame & { readonly event: E } {
  return { type: 'event', id: 'lane', laneId: LANE_ID, cursor: { epoch: EPOCH, seq: 1 }, event }
}

export function receiptFrame<R extends Receipt>(
  receipt: R,
): ReceiptFrame & { readonly receipt: R } {
  return { type: 'receipt', receipt }
}

export const CLIENT_FRAMES = {
  auth: {
    first: { type: 'auth', grant: GRANT, challenge: CHALLENGE, trace: TRACE },
    renewal: { type: 'auth', grant: GRANT },
  },
  'terminal.input': {
    input: { type: 'terminal.input', terminalId: TERMINAL_ID, seq: 1, data: 'ls\r' },
  },
  subscribe: {
    lanes: {
      type: 'subscribe',
      id: 'lanes',
      topic: 'lanes',
      after: { epoch: EPOCH, seq: 0 },
      trace: TRACE,
    },
    lane: {
      type: 'subscribe',
      id: 'lane',
      topic: 'lane',
      laneId: LANE_ID,
      after: { epoch: EPOCH, seq: 3 },
      trace: TRACE,
    },
    terminal: {
      type: 'subscribe',
      topic: 'terminal',
      id: 'terminal',
      terminalId: TERMINAL_ID,
      after: { epoch: EPOCH, seq: 0 },
    },
  } satisfies { readonly [K in SubscribeFrame['topic']]: Extract<SubscribeFrame, { topic: K }> },
  unsubscribe: { lanes: { type: 'unsubscribe', id: 'lanes' } },
  command: {
    fenced: {
      type: 'command',
      requestId: REQUEST_ID,
      laneId: LANE_ID,
      fence: 1,
      op: { type: 'prompt', message: 'Hello' },
      trace: TRACE,
    },
    unfenced: {
      type: 'command',
      requestId: REQUEST_ID,
      op: { type: 'lane.create', repositoryId: REPOSITORY_ID, worktree: null },
    },
  },
  'receipt-status': { status: { type: 'receipt-status', requestId: REQUEST_ID } },
  call: {
    state: {
      type: 'call',
      id: 'call',
      method: 'lane.state',
      params: { laneId: LANE_ID },
      trace: TRACE,
    },
  },
  ping: { ping: { type: 'ping', at: 1 } },
} satisfies FramesByType<ClientFrame>

export const HOST_FRAMES = {
  'terminal.ack': {
    ack: { type: 'terminal.ack', terminalId: TERMINAL_ID, seq: 1, accepted: true },
  },
  'terminal.output': {
    output: {
      type: 'terminal.output',
      id: 'terminal',
      terminalId: TERMINAL_ID,
      epoch: EPOCH,
      seq: 1,
      data: 'output',
    },
  },
  'terminal.reset': {
    reset: {
      type: 'terminal.reset',
      id: 'terminal',
      terminalId: TERMINAL_ID,
      epoch: EPOCH,
      seq: 1,
      data: 'scrollback',
      inputSeq: 1,
      status: 'running',
    },
  },
  'terminal.exit': {
    exit: {
      type: 'terminal.exit',
      id: 'terminal',
      terminalId: TERMINAL_ID,
      epoch: EPOCH,
      seq: 2,
      exitCode: 0,
    },
  },
  ready: {
    ready: {
      type: 'ready',
      protocolVersion: 1,
      hello: {
        hostId: HOST_ID,
        hostVersion: '1.0.0',
        protocolVersion: 1,
        runtimeEpoch: EPOCH,
        capabilities: ['sessions.read', 'sessions.control'],
      },
      proof: 'A'.repeat(86),
      connectionId: EPOCH,
      grantExpiresAt: TIME,
      client: { id: CLIENT_ID, label: 'Desktop' },
      capabilities: ['sessions.read'],
    },
  },
  'auth-renewed': { renewed: { type: 'auth-renewed', grantExpiresAt: TIME } },
  lanes: {
    lanes: {
      type: 'lanes',
      id: 'lanes',
      cursor: { epoch: EPOCH, seq: 0 },
      repositories: [{ id: REPOSITORY_ID, name: 'repo', path: '/home/user/repo' }],
      lanes: [SUMMARY],
    },
  },
  'lanes-delta': {
    delta: {
      type: 'lanes-delta',
      id: 'lanes',
      cursor: { epoch: EPOCH, seq: 1 },
      upsert: [SUMMARY],
      remove: [OTHER_LANE_ID],
    },
  },
  'routines-changed': {
    changed: { type: 'routines-changed', id: 'lanes', cursor: { epoch: EPOCH, seq: 1 } },
  },
  attention: {
    finished: {
      type: 'attention',
      id: 'lanes',
      cursor: { epoch: EPOCH, seq: 1 },
      event: {
        id: `${LANE_ID}:1`,
        laneId: LANE_ID,
        kind: 'finished',
        attention: 1,
        at: TIME,
        title: 'Lane',
      },
    },
  },
  snapshot: {
    snapshot: { type: 'snapshot', id: 'lane', laneId: LANE_ID, reset: false, snapshot: SNAPSHOT },
  },
  event: {
    pi: laneEventFrame({ kind: 'pi', push: LANE_PI_PUSHES.event }),
    control: laneEventFrame({ kind: 'control', control: CONTROL }),
    summary: laneEventFrame({ kind: 'summary', summary: SUMMARY }),
    'dialog-resolved': laneEventFrame({ kind: 'dialog-resolved', dialogId: 'dialog' }),
  } satisfies {
    readonly [K in LaneEvent['kind']]: EventFrame & {
      readonly event: Extract<LaneEvent, { kind: K }>
    }
  },
  'subscribe-failed': {
    failed: { type: 'subscribe-failed', id: 'lane', code: 'unknown-lane' },
  },
  receipt: {
    pending: receiptFrame({ requestId: REQUEST_ID, status: 'pending' }),
    done: receiptFrame({
      requestId: REQUEST_ID,
      status: 'done',
      data: { ok: true },
      fence: 2,
      laneId: LANE_ID,
    }),
    failed: receiptFrame({
      requestId: REQUEST_ID,
      status: 'failed',
      error: { code: 'pi-error', message: 'failure' },
    }),
    rejected: receiptFrame({
      requestId: REQUEST_ID,
      status: 'rejected',
      code: 'stale-fence',
      control: CONTROL,
    }),
    unknown: receiptFrame({ requestId: REQUEST_ID, status: 'unknown' }),
  } satisfies {
    readonly [K in Receipt['status']]: ReceiptFrame & {
      readonly receipt: Extract<Receipt, { status: K }>
    }
  },
  result: {
    ok: { type: 'result', id: 'call', ok: true, data: { value: 1 } },
    error: {
      type: 'result',
      id: 'call',
      ok: false,
      error: { code: 'unsupported', message: 'Unsupported method' },
    },
  } satisfies {
    readonly ok: Extract<ResultFrame, { ok: true }>
    readonly error: Extract<ResultFrame, { ok: false }>
  },
  error: { error: { type: 'error', code: 4401, message: 'Unauthenticated' } },
  pong: { pong: { type: 'pong', at: 1 } },
} satisfies FramesByType<HostFrame>

export interface FrameCase<F> {
  readonly type: string
  readonly variant: string
  readonly frame: F
}

export function frameCases<F>(
  frames: Readonly<Record<string, Readonly<Record<string, F>>>>,
): FrameCase<F>[] {
  return Object.entries(frames).flatMap(([type, variants]) =>
    Object.entries(variants).map(([variant, frame]) => ({ type, variant, frame })),
  )
}

/** Every `command` op type. LaneOpType is erased too; tsc keeps this record complete. */
export const LANE_OP_TYPES = {
  prompt: true,
  steer: true,
  follow_up: true,
  abort: true,
  abort_retry: true,
  set_model: true,
  set_thinking_level: true,
  compact: true,
  set_session_name: true,
  extension_ui_response: true,
  'lane.create': true,
  'lane.resume': true,
  'lane.stop': true,
  'lane.markRead': true,
  'lane.delete': true,
  'control.take': true,
  'control.release': true,
  'host.repositories.add': true,
  'host.repositories.remove': true,
  'host.repositories.createFolder': true,
  'provider.login': true,
  'machine.task': true,
  'claude.account': true,
  'terminal.create': true,
  'terminal.resize': true,
  'terminal.kill': true,
  'routine.save': true,
  'routine.run': true,
  'routine.cancel': true,
  'routine.skipNext': true,
  'routine.archive': true,
  'routine.delete': true,
  'routine.pauseAll': true,
  'files.write': true,
  'files.create': true,
  'files.rename': true,
  'files.delete': true,
  'files.transfer': true,
  'attachments.begin': true,
  'attachments.chunk': true,
  'attachments.commit': true,
} satisfies Record<LaneOpType, true>
