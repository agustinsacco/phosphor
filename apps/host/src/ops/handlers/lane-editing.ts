import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op, pageRows } from '@phosphor/session-runtime/ops/results'
import type { LaneFacts, OpHandler, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { hostIdOfPath, remoteLaneKey } from '@phosphor/shared/remote-host'
import {
  forkLane,
  jumpIsCurrent,
  jumpLaneTo,
  labelLaneEntry,
  labelOf,
  laneLineage,
  LaneEditRefused,
  readLaneTree,
  type LaneEditingPorts,
  type LaneForkKind,
} from '../../lanes/editing'
import type { StoredLane } from '../../lanes/store'
import { laneIdInRef } from '../binding'
import type { DaemonHandlerDeps, DaemonUndoCheck } from './index'

/**
 * `lane.tree`, `lane.label`, `lane.jump`, `lane.fork`, `lane.clone` and
 * `lane.rewind` (ready flag `laneEditing`), over `lanes/editing.ts`. The
 * dispatcher has already resolved the lane, refused a surface that does not
 * control it, and refused an agent on another lane's running turn.
 */

const portsOf = (deps: DaemonHandlerDeps): LaneEditingPorts => ({
  ...deps.editing,
  store: deps.store,
  db: deps.db,
})

function storedLane(deps: DaemonHandlerDeps, ref: string): StoredLane | null {
  const lane = deps.store.getLane(laneIdInRef(ref))
  return lane && lane.removedAt === null ? lane : null
}

function targetOf(
  deps: DaemonHandlerDeps,
  ctx: OpHandlerContext,
): { facts: LaneFacts; lane: StoredLane } {
  const facts = ctx.lane
  const lane = facts ? storedLane(deps, facts.ref) : null
  if (!facts || !lane) throw new OpRefusal('bad-request', 'No such lane on this machine.')
  return { facts, lane }
}

/** Labels and jumps rewrite the lane's own file, which pi owns while the lane runs. */
function refuseOpen(facts: LaneFacts): void {
  if (facts.sessionId !== null)
    throw new OpRefusal(
      'unavailable',
      `Lane ${facts.title} is open. Stop it before changing its saved conversation.`,
    )
}

/** Editing's own refusals are the caller's to fix; anything else is a failure. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof LaneEditRefused) throw new OpRefusal('bad-request', error.message)
    throw error
  }
}

/** A new lane's ref, under the same machine id the source was named by. */
function siblingRef(facts: LaneFacts, laneId: string): string {
  const hostId = hostIdOfPath(facts.ref)
  return hostId === undefined ? laneId : remoteLaneKey(hostId, laneId)
}

const tree = (deps: DaemonHandlerDeps) =>
  op<{ ref: string }>(async (_args, ctx) => {
    const { lane } = targetOf(deps, ctx)
    const read = await refusing(() => readLaneTree(lane))
    const page = pageRows(read.entries, ctx, 500)
    const data = { sessionId: read.sessionId, leafId: read.leafId, entries: page.data }
    return { ...dataResult(data), ...(page.next !== undefined ? { next: page.next } : {}) }
  })

const label = (deps: DaemonHandlerDeps) =>
  op<{ ref: string; entry: string; label?: string }>(async (args, ctx) => {
    const { facts, lane } = targetOf(deps, ctx)
    refuseOpen(facts)
    const text = args.label === undefined || args.label === '' ? undefined : args.label
    const { previous } = await refusing(() => labelLaneEntry(portsOf(deps), lane, args.entry, text))
    return {
      text:
        text === undefined
          ? `Cleared the label on entry ${args.entry} in lane ${facts.title}.`
          : `Labeled entry ${args.entry} in lane ${facts.title}.`,
      data: { entry: args.entry, ...(text !== undefined ? { label: text } : {}) },
      before: {
        ref: args.ref,
        entry: args.entry,
        ...(previous !== undefined ? { label: previous } : {}),
      },
    }
  })

const jump = (deps: DaemonHandlerDeps) =>
  op<{ ref: string; entry: string }>(async (args, ctx) => {
    const { facts, lane } = targetOf(deps, ctx)
    refuseOpen(facts)
    const { previousLeaf } = await refusing(() => jumpLaneTo(portsOf(deps), lane, args.entry))
    const moved = previousLeaf !== null && previousLeaf !== args.entry
    return {
      text: moved
        ? `Lane ${facts.title} continues from entry ${args.entry} when it resumes.`
        : `Lane ${facts.title} already continues from entry ${args.entry}.`,
      data: { entry: args.entry, previousLeaf },
      ...(moved ? { before: { ref: args.ref, entry: previousLeaf } } : {}),
    }
  })

const FORKED: Readonly<Record<LaneForkKind, string>> = {
  fork: 'Forked',
  clone: 'Cloned',
  rewind: 'Rewound',
}

const fork = (deps: DaemonHandlerDeps, kind: LaneForkKind) =>
  op<{ ref: string; at?: string; entry?: string }>(async (args, ctx) => {
    const { facts, lane } = targetOf(deps, ctx)
    const at = kind === 'rewind' ? args.entry : args.at
    const forked = await refusing(() =>
      forkLane(portsOf(deps), lane, {
        kind,
        ...(at !== undefined ? { at } : {}),
        lineage: laneLineage(ctx.principal, deps.db),
      }),
    )
    const ref = siblingRef(facts, forked.lane.laneId)
    return {
      text: `${FORKED[kind]} lane ${facts.title} into a new lane ${ref}; the original is unchanged.`,
      data: {
        lane: ref,
        ...(forked.prefill !== undefined ? { prefill: forked.prefill } : {}),
        ...(forked.ledgerForked !== undefined ? { ledgerForked: forked.ledgerForked } : {}),
      },
      // A rewind's new lane replaces the source; archiving it is not the inverse a user means.
      ...(kind === 'rewind' ? {} : { before: { ref } }),
      next: `lane.resume ${ref}`,
    }
  })

export function laneEditingHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {
    'lane.tree': tree(deps),
    'lane.label': label(deps),
    'lane.jump': jump(deps),
    'lane.fork': fork(deps, 'fork'),
    'lane.clone': fork(deps, 'clone'),
    'lane.rewind': fork(deps, 'rewind'),
  }
}

const field = (value: unknown, key: string): string | undefined => {
  const v =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined
  return typeof v === 'string' ? v : undefined
}

/** A new lane's Undo (archive it) holds while that lane is still there, unarchived. */
const forkedLaneCurrent: DaemonUndoCheck = (before, deps) => {
  const ref = field(before, 'ref')
  return ref !== undefined && storedLane(deps, ref) !== null
}

/**
 * Undo preconditions for lane editing: the lane still shows what the change
 * left. A label Undo needs the label it set (`forward`), a jump Undo the leaf
 * it moved to; without them the change does not count as current.
 */
export const laneEditingUndoChecks: Readonly<Record<string, DaemonUndoCheck>> = {
  'lane.label': async (before, deps, forward) => {
    const ref = field(before, 'ref')
    const entry = field(before, 'entry')
    const lane = ref === undefined ? null : storedLane(deps, ref)
    if (!lane || entry === undefined || !forward || field(forward, 'entry') !== entry) return false
    const set = field(forward, 'label')
    return labelOf(await readLaneTree(lane), entry) === (set === '' ? undefined : set)
  },
  'lane.jump': async (before, deps, forward) => {
    const ref = field(before, 'ref')
    const lane = ref === undefined ? null : storedLane(deps, ref)
    const entry = field(forward, 'entry')
    if (!lane || entry === undefined) return false
    return jumpIsCurrent(lane, entry)
  },
  'lane.fork': forkedLaneCurrent,
  'lane.clone': forkedLaneCurrent,
}
