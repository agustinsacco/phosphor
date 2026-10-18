import type { GrantPayload } from '../../host-grant'
import type { LaneOp, RejectCode } from '../../host-protocol'
import type { ThinkingLevel } from '../../rpc'
import { send } from './delivery'
import { now, type Command, type FakeHostState, type Lane } from './state'
import { announce, changeControl, publish, summary } from './streams'

/** Why an admitted command was refused; `lane` adds the lane's current control to the receipt. */
export interface Refusal {
  code: RejectCode
  lane?: Lane
}
type CreateOp = Extract<LaneOp, { type: 'lane.create' }>

/** Creates and announces a lane controlled by its creator; returns its id or a refusal. */
export function createLane(
  state: FakeHostState,
  grant: GrantPayload,
  f: Command,
  op: CreateOp,
): string | Refusal {
  const { options, limits, repositories } = state
  if (f.laneId !== undefined || !repositories.some((r) => r.id === op.repositoryId))
    return { code: 'bad-request' }
  if (state.lanes.size >= limits.lanesPerHost) return { code: 'too-many-requests' }
  const laneId = options.id()
  const lane: Lane = {
    summary: {
      laneId,
      repositoryId: op.repositoryId,
      cwd: repositories.find((r) => r.id === op.repositoryId)?.path ?? '/test',
      title: op.name ?? null,
      branch: op.worktree?.branch ?? null,
      worktree: op.worktree !== null,
      model: op.provider && op.model ? { provider: op.provider, id: op.model } : null,
      activity: 'idle',
      createdAt: now(),
      updatedAt: now(),
      attention: 0,
      read: 0,
      control: {
        fence: 1,
        controller: { clientId: grant.client.id, label: grant.client.label, connected: true },
      },
    },
    thinkingLevel: op.thinkingLevel === undefined ? 'off' : thinkingLevel(op.thinkingLevel),
    sessionId: options.id(),
    seq: 0,
    events: [],
    replayBytes: 0,
    messages: [],
    pending: [],
    dialogs: [],
    ui: new Map(),
  }
  state.lanes.set(laneId, lane)
  announce(state, send, lane)
  return laneId
}

/** Fences every op except take and markRead; an uncontrolled lane is claimed before the op. */
export function admitController(
  state: FakeHostState,
  grant: GrantPayload,
  f: Command,
  l: Lane,
): Refusal | null {
  if (f.op.type === 'control.take' || f.op.type === 'lane.markRead') return null
  if (f.fence !== l.summary.control.fence) return { code: 'stale-fence', lane: l }
  const controller = l.summary.control.controller
  if (controller && controller.clientId !== grant.client.id)
    return { code: 'not-controller', lane: l }
  if (f.op.type === 'control.release' && !controller) return { code: 'not-controller', lane: l }
  if (!controller)
    changeControl(state, send, l, {
      clientId: grant.client.id,
      label: grant.client.label,
      connected: true,
    })
  return null
}

/** Applies the op's lane, control, dialog or model change. Other ops change nothing here. */
export function applyOperation(
  state: FakeHostState,
  grant: GrantPayload,
  op: LaneOp,
  l: Lane,
): Refusal | null {
  if (op.type === 'control.take')
    changeControl(state, send, l, {
      clientId: grant.client.id,
      label: grant.client.label,
      connected: true,
    })
  else if (op.type === 'control.release') changeControl(state, send, l, null)
  else if (op.type === 'lane.markRead') {
    l.summary = {
      ...l.summary,
      read: Math.max(l.summary.read, Math.min(op.upTo, l.summary.attention)),
    }
    summary(state, send, l)
  } else if (op.type === 'lane.stop') {
    l.summary = { ...l.summary, activity: 'stopped' }
    summary(state, send, l)
  } else if (op.type === 'lane.resume') {
    l.summary = { ...l.summary, activity: 'idle' }
    summary(state, send, l)
  } else if (l.summary.activity === 'stopped' || l.summary.activity === 'failed')
    return { code: 'lane-stopped' }
  else if (op.type === 'extension_ui_response') return resolveDialog(state, l, op.response.id)
  else if (op.type === 'set_session_name') {
    l.summary = { ...l.summary, title: op.name }
    summary(state, send, l)
  } else if (op.type === 'set_thinking_level') l.thinkingLevel = op.level
  else if (op.type === 'set_model') {
    l.summary = { ...l.summary, model: { provider: op.provider, id: op.modelId } }
    summary(state, send, l)
  }
  return null
}

/** Only an open dialog resolves: the resolution streams before the activity summary. */
function resolveDialog(state: FakeHostState, l: Lane, id: string): Refusal | null {
  if (!l.dialogs.some((d) => d.id === id)) return { code: 'bad-request' }
  l.dialogs = l.dialogs.filter((d) => d.id !== id)
  publish(state, send, l, { kind: 'dialog-resolved', dialogId: id })
  l.summary = { ...l.summary, activity: l.dialogs.length ? 'needs-input' : 'idle' }
  summary(state, send, l)
  return null
}

export function thinkingLevel(value: string): ThinkingLevel {
  switch (value) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value
    default:
      throw new Error('Invalid thinking level')
  }
}
