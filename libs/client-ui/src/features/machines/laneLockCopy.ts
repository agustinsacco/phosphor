import type { HostLaneView } from '@shared/ipc'

type Controller = HostLaneView['control']['controller']

export interface LaneLockCopy {
  /** Who holds the lane, shown in bold before `message`; null when nobody does. */
  holder: string | null
  message: string
  /** The take button, or null when this client cannot take the lane at all. */
  action: {
    label: string
    /** Someone is connected and driving: ask before taking it from them. */
    confirm: boolean
  } | null
}

export const NOBODY_HAS_CONTROL = 'Nobody has control of this lane.'

/**
 * What a reader's locked composer says and offers. Friction follows risk: a
 * missing or disconnected holder is taken in one step, a connected one only
 * after a confirmation. `takenBy` names whoever took the lane from this client.
 */
export function laneLockCopy({
  controller,
  canTake,
  takenBy,
  hint,
}: {
  controller: Controller | undefined
  /** The Host offers control to this client and the lane can change hands. */
  canTake: boolean
  takenBy: string | null
  /** Why this client cannot take the lane, when it cannot. */
  hint?: string
}): LaneLockCopy {
  if (!canTake) return { holder: null, message: hint ?? 'Read-only.', action: null }
  if (!controller) {
    return {
      holder: null,
      message: NOBODY_HAS_CONTROL,
      action: { label: 'Take control', confirm: false },
    }
  }
  const confirm = controller.connected
  if (takenBy !== null && takenBy === controller.label) {
    return {
      holder: controller.label,
      message: 'took control from you.',
      action: { label: confirm ? 'Take back…' : 'Take back', confirm },
    }
  }
  return {
    holder: controller.label,
    message: `has control · ${confirm ? 'connected' : 'disconnected'}`,
    action: { label: confirm ? 'Take over…' : 'Take control', confirm },
  }
}

/** The confirmation names who loses the lane. */
export function takeOverQuestion(holder: string): string {
  return `${holder} becomes read-only.`
}
