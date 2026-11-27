import { useSessionsStore } from '@/stores/sessions'
import { isNewerVersion } from '@shared/version'
import { useChatStore } from '@/stores/chat'
import { piCallInline, piCallOk } from '@/lib/rpc'
import { cancelHeldComposerPrompts } from '../sendComposerPrompt'

/** The pi release that added `clear_queue`. Below `MIN_PI_VERSION`, so only an older, unsupported pi lacks it. */
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
  const remote = useSessionsStore.getState().live[sessionId]?.target?.kind === 'remote'
  const response = await window.phosphor.piCommand<'clear_queue'>(sessionId, {
    type: 'clear_queue',
  })
  const drainedQueues = response.success ? response.data : undefined
  if (!drainedQueues) {
    const rejection = response.success ? null : response.error
    chat.setError(sessionId, await unqueueFailureMessage(rejection, remote))
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
 * Stop the running turn, restoring unsent composer prompts and handing `restore` pi's queued text.
 *
 * pi's abort keeps both queues and its next turn delivers them, so Stop drains them first and
 * restores what pi drained. On a pi without `clear_queue`, or when the drain fails, it restores
 * the rendered queue and pi keeps its own. A failed abort is reported on the chat.
 */
export async function stopRun(sessionId: string, restore: (text: string) => void): Promise<void> {
  cancelHeldComposerPrompts(sessionId)
  const queues = useChatStore.getState().sessions[sessionId]?.queues
  const shown = [...(queues?.steering ?? []), ...(queues?.followUp ?? [])]
  if (shown.length > 0) {
    const drain = await piCallInline(sessionId, { type: 'clear_queue' })
    const drained = drain.ok ? drain.data : undefined
    const text = drained ? [...drained.steering, ...drained.followUp] : shown
    if (text.length > 0) restore(text.join('\n'))
  }
  await piCallOk(sessionId, { type: 'abort' })
}

/**
 * Explain a failed drain in terms the reader can act on.
 *
 * `clear_queue` predates `MIN_PI_VERSION`, but a session can still be running
 * a pi older than the minimum, and pi can refuse for its own reasons — naming
 * the requirement alone left the user with no way to tell whether that was
 * their case. The installed version has to come from the main process; the
 * chat store knows pi's protocol, not its build. Health is TTL-cached there,
 * so this is cheap.
 *
 * Upgrading is not the whole instruction either: the session is already bound
 * to a subprocess of the old pi, which lives until the session is restarted.
 *
 * `rejection` is pi's own error, or null when pi answered success with no
 * queues. Only a rejection proves the queues were left alone, so only then
 * does this promise they were.
 */
async function unqueueFailureMessage(rejection: string | null, remote: boolean): Promise<string> {
  const parts = [
    `Could not remove the queued message: ${rejection ?? 'clear_queue returned no queues'}.`,
  ]
  // A Host lane's failure may be an unconfirmed outcome, not a refusal, and it
  // runs the Host's pi, so this machine's version says nothing about it either.
  if (remote) return parts.join(' ')
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
