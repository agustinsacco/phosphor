import type { UndoPorts } from '@phosphor/session-runtime/ops/undo'
import type { OpsBinding } from '@phosphor/session-runtime/ops/types'
import { daemonUndoIsCurrent, hasDaemonUndoCheck, type DaemonHandlerDeps } from './handlers'
import { folderUndoCurrent } from './handlers/folders'
import { LANE_SELF_UNDO_OPS, laneSelfUndoCurrent } from './handlers/lane-self-undo'
import { laneUndoCurrent } from './handlers/lane-undo'
import { routineUndoCurrent } from './handlers/routines'
import { SETTINGS_UNDO_OPS, settingsAreCurrent } from './handlers/settings'

export type UndoCheck = UndoPorts['isCurrent']

/**
 * Whether a recorded inverse still matches the machine. Each handler family
 * claims its ops; the first family that claims an op decides. An op no
 * family claims is never current, so its Undo refuses.
 */
export function undoCurrent(
  families: readonly (readonly [owns: (op: string) => boolean, check: UndoCheck])[],
): UndoCheck {
  return async (entry) => {
    const family = families.find(([owns]) => owns(entry.op))
    return family ? await family[1](entry) : false
  }
}

/** The daemon's one undo table: each handler family's check, most specific first. */
export function daemonUndoChecks(
  deps: DaemonHandlerDeps,
  resolve: OpsBinding['lanes']['resolve'],
): UndoCheck {
  return undoCurrent([
    [hasDaemonUndoCheck, async (entry) => daemonUndoIsCurrent(entry, deps)],
    [(op) => op.startsWith('routine.'), async (entry) => routineUndoCurrent(deps, entry)],
    [(op) => op.startsWith('folder.'), async (entry) => folderUndoCurrent(deps, entry)],
    [(op) => SETTINGS_UNDO_OPS.has(op), settingsAreCurrent(deps)],
    [(op) => LANE_SELF_UNDO_OPS.has(op), laneSelfUndoCurrent({ resolve, store: deps.store })],
    [() => true, async (entry) => laneUndoCurrent(deps, entry)],
  ])
}
