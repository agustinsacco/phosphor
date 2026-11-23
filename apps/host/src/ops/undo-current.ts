import type { UndoPorts } from '@phosphor/session-runtime/ops/undo'

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
