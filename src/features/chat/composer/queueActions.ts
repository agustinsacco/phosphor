import { isNewerVersion } from '@shared/version'
import { useChatStore } from '@/stores/chat'
import { piCallOk } from '@/lib/rpc'

/** The pi release that added `clear_queue`. Above `MIN_PI_VERSION`, on purpose. */
export const CLEAR_QUEUE_MIN_PI = '0.84.4'

/**
 * Drop one entry from a rendered queue snapshot, returning the survivors.
 *
 * The index comes from the chip row, which renders the last `queue_update`. pi
 * can deliver a queued message between that render and the click, so the index
 * alone is not trustworthy: it is used only when the text at it still matches,
 * and otherwise the first equal text wins. `null` means the entry is already
 * gone (pi read it) and the caller must not claim a removal.
 */
export function dropQueuedEntry(queue: string[], index: number, text: string): string[] | null {
  const at = queue[index] === text ? index : queue.indexOf(text)
  if (at === -1) return null
  return [...queue.slice(0, at), ...queue.slice(at + 1)]
}

/**
 * Undo a queued steering / follow-up message that pi has not read yet.
 *
 * pi's protocol has no "remove entry N": the only queue mutation is
 * `clear_queue` (pi 0.84.4+), which drains BOTH queues and returns what it
 * drained. So an undo is drain-then-re-queue-the-survivors, in order — and a
 * re-queue re-runs pi's skill / prompt-template expansion, which is a no-op on
 * text that does not start with `/`, as already-expanded queue text does not.
 *
 * On an older pi the drain fails and nothing is lost: pi answers
 * `Unknown command: clear_queue` with both queues untouched.
 */
export async function unqueueMessage(
  sessionId: string,
  kind: 'steer' | 'follow-up',
  index: number,
  text: string,
): Promise<void> {
  const chat = useChatStore.getState()
  const response = await window.phosphor.piCommand<'clear_queue'>(sessionId, {
    type: 'clear_queue',
  })
  const drainedQueues = response.success ? response.data : undefined
  if (!drainedQueues) {
    const rejection = response.success ? null : response.error
    chat.setError(sessionId, await unqueueFailureMessage(rejection))
    return
  }

  const { steering, followUp } = drainedQueues
  const dropped = dropQueuedEntry(kind === 'steer' ? steering : followUp, index, text)
  const keptSteering = kind === 'steer' ? (dropped ?? steering) : steering
  const keptFollowUp = kind === 'follow-up' ? (dropped ?? followUp) : followUp

  // Re-queue survivors before reporting: a failure here would otherwise drop
  // messages the user still wants, so the error names what was lost.
  const lost: string[] = []
  for (const message of keptSteering) {
    if (!(await piCallOk(sessionId, { type: 'steer', message }))) lost.push(message)
  }
  for (const message of keptFollowUp) {
    if (!(await piCallOk(sessionId, { type: 'follow_up', message }))) lost.push(message)
  }
  if (lost.length > 0) {
    chat.setError(sessionId, `Could not re-queue ${lost.length} message(s): ${lost.join(' · ')}`)
    return
  }
  if (dropped === null) {
    chat.setError(sessionId, 'That message was already delivered to the agent.')
  }
}

/**
 * Explain a failed drain in terms the reader can act on.
 *
 * `clear_queue` sits above `MIN_PI_VERSION`, so a perfectly supported install
 * can be running a pi that never heard of it — naming the requirement alone
 * left the user with no way to tell whether that was their case. The installed
 * version has to come from the main process; the chat store knows pi's
 * protocol, not its build. Health is TTL-cached there, so this is cheap.
 *
 * Upgrading is not the whole instruction either: the session is already bound
 * to a subprocess of the old pi, which lives until the session is restarted.
 *
 * `rejection` is pi's own error, or null when pi answered success with no
 * queues. Only a rejection proves the queues were left alone, so only then
 * does this promise they were.
 */
async function unqueueFailureMessage(rejection: string | null): Promise<string> {
  const parts = [
    `Could not remove the queued message: ${rejection ?? 'clear_queue returned no queues'}.`,
  ]
  if (rejection) parts.push('Your queued messages are unchanged.')

  const installed = await window.phosphor
    .invoke('pi:health')
    .then((health) => health.version)
    .catch(() => undefined)
  if (!installed || isNewerVersion(CLEAR_QUEUE_MIN_PI, installed)) {
    parts.push(
      `Removing a queued message needs pi ${CLEAR_QUEUE_MIN_PI} or newer${installed ? `; this machine has ${installed}` : ''}.`,
      'Update with npm install -g @earendil-works/pi-coding-agent@latest, then start a new session — this one keeps the pi it spawned.',
    )
  }
  return parts.join(' ')
}
