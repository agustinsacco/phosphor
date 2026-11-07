import type { ReactNode } from 'react'
import type { ContextMenuItem } from '@/components/ContextMenu'
import type { LanePrefs } from '@shared/models'

export type LaneActionId =
  | 'open'
  | 'rename'
  | 'tree'
  | 'completion'
  | 'restoreWorktree'
  | 'makeRoutine'
  | 'pin'
  | 'marker'
  | 'openPullRequest'
  | 'control'
  | 'stop'
  | 'resume'
  | 'markRead'
  | 'fork'
  | 'clone'
  | 'exportHtml'
  | 'copyDebugInfo'
  | 'copySpend'
  | 'delete'

/** One lane, machine-blind: data and refusals only. */
export interface LaneActionContext {
  pinned: boolean
  markers: LanePrefs['markers']
  pr: { number: number; state?: string } | null
  unseen: boolean
  running: boolean
  /** Undefined where the machine keeps no completion (a Host today). */
  completed?: boolean
  worktreeRemoved?: boolean
  /** A spend to copy: a known one shows as the hint, `{}` means it is fetched on click. */
  spend?: { hint?: string }
  /** Present where a lane has a controller (a Host): whether this device holds it. */
  control?: { self: boolean }
  /** An action on this lane is in flight: every item waits. */
  busy: boolean
  /** Why an action is refused now, in the shared words. Absent means allowed. */
  refusals: Partial<Record<LaneActionId, string>>
  /** What an allowed action does on this machine ("~200 MB", "to trash"). */
  hints?: Partial<Record<LaneActionId, string>>
}

/** A missing handler is how a machine says it lacks the action: the item is not offered. */
export type LaneActionHandlers = Partial<
  Record<Exclude<LaneActionId, 'control'>, () => void> & {
    takeControl: () => void
    releaseControl: () => void
  }
>

/** What a machine's lane-actions hook gives its row: the menu, the dialogs it opens, the marker picker. */
export interface LaneActions {
  items: () => ContextMenuItem[]
  /** Rendered beside the row; the dialogs portal through `ModalOverlay`. */
  dialogs: ReactNode
  /** Opens the marker picker; absent where this lane cannot be marked now. */
  pickMarker?: () => void
}

/**
 * A lane's menu on every machine and surface: This Mac's order, with a Host's
 * control item before Stop. Absent data hides an item (no pull request, not
 * unseen, no completion, no handler); a refusal disables it and names itself.
 */
export function laneActions(
  ctx: LaneActionContext,
  handlers: LaneActionHandlers,
  /** Move up and Move down, where the row sits in an ordered list (`SessionList`). */
  order: ContextMenuItem[] = [],
): ContextMenuItem[] {
  const offer = (id: LaneActionId, label: string, onClick?: () => void, hint?: string) => {
    if (!onClick) return []
    const refusal = ctx.refusals[id]
    const disabled = ctx.busy || refusal !== undefined
    return [{ label, onClick, disabled, hint: refusal ?? hint ?? ctx.hints?.[id] }]
  }
  const { pr, control, running } = ctx
  const lane: ContextMenuItem[] = [
    ...offer('open', 'Open', handlers.open),
    ...order,
    ...offer('rename', 'Rename…', handlers.rename),
    ...offer('tree', 'Session tree…', handlers.tree),
    ...(ctx.completed === undefined
      ? []
      : offer(
          'completion',
          ctx.completed ? 'Reopen conversation' : 'Finish conversation…',
          handlers.completion,
        )),
    ...(ctx.worktreeRemoved
      ? offer('restoreWorktree', 'Restore worktree…', handlers.restoreWorktree)
      : []),
    ...offer('makeRoutine', 'Make routine…', handlers.makeRoutine),
    ...offer('pin', ctx.pinned ? 'Unpin' : 'Pin', handlers.pin),
    ...(ctx.markers === 'off' ? [] : offer('marker', 'Lane marker…', handlers.marker)),
    ...(pr
      ? offer(
          'openPullRequest',
          `Open pull request #${pr.number}`,
          handlers.openPullRequest,
          pr.state?.toLowerCase(),
        )
      : []),
    ...(!control
      ? []
      : control.self
        ? offer('control', 'Release control', handlers.releaseControl)
        : offer('control', 'Take control', handlers.takeControl)),
    ...(running
      ? offer('stop', 'Stop', handlers.stop)
      : offer('resume', 'Resume', handlers.resume)),
    ...(ctx.unseen ? offer('markRead', 'Mark read', handlers.markRead) : []),
  ]
  const copies: ContextMenuItem[] = [
    ...offer('fork', 'Fork', handlers.fork, 'new branch'),
    ...offer('clone', 'Clone', handlers.clone),
    ...offer('exportHtml', 'Export HTML…', handlers.exportHtml),
    ...offer('copyDebugInfo', 'Copy debug info', handlers.copyDebugInfo),
    ...(ctx.spend ? offer('copySpend', 'Copy spend', handlers.copySpend, ctx.spend.hint) : []),
  ]
  const remove = offer('delete', 'Delete', handlers.delete).map((item) => ({
    ...item,
    danger: true,
  }))
  return [...lane, ...section(copies), ...section(remove)]
}

/** A section opens with a separator, whichever of its items the machine offers first. */
function section(items: ContextMenuItem[]): ContextMenuItem[] {
  return items.map((item, index) => (index === 0 ? { ...item, separatorAbove: true } : item))
}
