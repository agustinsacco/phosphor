import { commandRefusal } from '../../session/runtime'
import { log } from './receipts'
import { toPiCommand } from './rpc'
import type { LaneCommandPorts } from './state'

export type FirstPromptPorts = Pick<LaneCommandPorts, 'runtime' | 'sessionFor' | 'refusal' | 'log'>

/**
 * Send a `lane.create`'s prompt the way a client's `prompt` op goes to pi: the same
 * allowlist and refusal policy, then `runtime.command`, so the session preflight
 * (context budget sync, lane reload) and the first-prompt hooks (title fallback,
 * `live.firstPrompt`, auto-naming) run as for any first prompt. The pi command
 * carries the creation's request id.
 *
 * The answer becomes the done receipt's `data.prompted`, and the client resends the
 * prompt only on `false`, so `false` must mean pi surely never took it:
 * - `true`: pi accepted the prompt.
 * - `false`: never sent (no live session, refused) or pi answered it with an error.
 * - `undefined`: the call threw, so pi may have it. The receipt then carries no
 *   `data`, and a client of a `laneStart` Host does not send the prompt again.
 */
export async function sendFirstPrompt(
  ports: FirstPromptPorts,
  target: { laneId: string; requestId: string },
  message: string,
): Promise<boolean | undefined> {
  const { laneId, requestId } = target
  let prompted: boolean | undefined = false
  let sending = false
  try {
    const sessionId = ports.sessionFor(laneId)
    const command = toPiCommand({ type: 'prompt', message }, requestId)
    if (sessionId !== null && command && (ports.refusal ?? commandRefusal)(command) === null) {
      sending = true
      prompted = (await ports.runtime.command(sessionId, command)).success
    }
  } catch {
    // Before the runtime call nothing reached pi; after it, pi may have the prompt.
    prompted = sending ? undefined : false
  }
  log(ports, 'lane.first_prompt', {
    laneId,
    requestId,
    outcome: prompted === undefined ? 'unknown' : prompted ? 'accepted' : 'refused',
  })
  return prompted
}
