/**
 * Who controls Brain Agent's conversation, at which fence. The fence lives in the binding and
 * only increases, across restarts: any take changes it, so an act against an older page is
 * refused, never applied to a newer state. Control changes one at a time and is never held
 * across a pi turn or an answer.
 */
import type { BrainSurfaceAuthority } from '../../api/brain-adapter'
import type { BrainAgentBindingFile } from './binding'

export type ControlRefusal = 'unavailable' | 'not-controller'

export function createConversationControl(binding: BrainAgentBindingFile) {
  let controller: { clientId: string; label: string } | null = null
  let known: number | undefined
  let queue: Promise<unknown> = Promise.resolve()

  async function fence(): Promise<number> {
    if (known === undefined) {
      const persisted = await binding.read()
      known ??= persisted.fence
    }
    return known
  }
  const holds = (caller: BrainSurfaceAuthority) => controller?.clientId === caller.client.id

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  function takeControl(caller: BrainSurfaceAuthority): Promise<boolean> {
    return binding.advance(
      () => caller.admit(),
      (at) => {
        known = at
        controller = { clientId: caller.client.id, label: caller.client.label }
      },
    )
  }

  return {
    fence,
    holds,
    controller: () => controller && { ...controller },
    /** Takes control at `expected`, from anyone. */
    take: (expected: number, caller: BrainSurfaceAuthority) =>
      serial(async (): Promise<'ok' | ControlRefusal> => {
        if (!caller.admit()) return 'unavailable'
        const at = await fence()
        if (!caller.admit()) return 'unavailable'
        if (expected !== at) return 'not-controller'
        return (await takeControl(caller)) ? 'ok' : 'unavailable'
      }),
    /** The fence when `caller` controls at `expected`; `claim` takes a free lane. */
    admit: (expected: number, caller: BrainSurfaceAuthority, claim: boolean) =>
      serial(async (): Promise<{ fence: number } | ControlRefusal> => {
        if (!caller.admit()) return 'unavailable'
        const at = await fence()
        if (!caller.admit()) return 'unavailable'
        if (expected !== at) return 'not-controller'
        if (controller && !holds(caller)) return 'not-controller'
        if (!controller) {
          if (!claim) return 'not-controller'
          if (!(await takeControl(caller))) return 'unavailable'
        }
        return { fence: known! }
      }),
    /** Still the caller's control at the fence it acted on (any, for null), and still authorized. */
    current: (caller: BrainSurfaceAuthority, at: number | null) =>
      caller.admit() && known === (at ?? known) && (!controller || holds(caller)),
    /** Whether anyone but `caller` controls the lane. */
    heldByOther: (caller: BrainSurfaceAuthority) => controller !== null && !holds(caller),
  }
}

export type ConversationControl = ReturnType<typeof createConversationControl>
