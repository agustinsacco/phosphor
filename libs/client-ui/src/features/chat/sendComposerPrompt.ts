import { ipcErrorText } from '@shared/errors'
import type { RpcResponseDataMap } from '@shared/rpc'
import { piCallInline } from '@/lib/rpc'
import { useChatStore } from '@/stores/chat'
import { takeSubmittedDraft, useDraftsStore } from '@/stores/drafts'
import { useWritingStore } from '@/stores/writing'
import { composePrompt, toImageContents } from './attachments'
import { uploadPromptFiles } from './uploadPromptFiles'
import { showPendingChip } from './composer/pendingQueue'
import { laneBusyNow } from './laneBusy'
import { canControlSession } from '@/stores/remoteLanes'
import { sessionTransitionPending } from '@/features/sessions/sessionTransition'

type Submission = {
  sessionId: string
  draftKey: string
  restoreDraftKey?: () => string
  remote: boolean
  remoteAttachments: boolean
  /** How the message goes while the lane is busy; Enter and Send steer. Unused while idle. */
  busyBehavior?: 'followUp' | 'steer'
}
export const COMPACTING_DRAFT = 'Compaction in progress. Send your draft when it finishes.'

type PromptSlot = { receipt: Promise<void>; cancel?: () => void }
/** Keep a later send behind uploads, automatic resume, and the final prompt reply. */
const pending = new Map<string, Set<PromptSlot>>()

function promptSlot(sessionId: string, restore: () => void) {
  const lane = pending.get(sessionId) ?? new Set<PromptSlot>()
  const previous = [...lane].at(-1)?.receipt
  let cancelled = false
  let done!: () => void
  const receipt = new Promise<void>((resolve) => {
    done = resolve
  })
  const slot: PromptSlot = {
    receipt,
    cancel() {
      cancelled = true
      release()
      restore()
    },
  }
  const release = () => {
    if (!lane.delete(slot)) return
    if (!lane.size) pending.delete(sessionId)
    done()
  }
  lane.add(slot)
  pending.set(sessionId, lane)
  return {
    previous,
    release,
    get cancelled() {
      return cancelled
    },
    dispatch() {
      slot.cancel = undefined
    },
  }
}

export function cancelHeldComposerPrompts(sessionId: string): void {
  // Each restore prepends its text and attachments. Walk backwards to keep send order.
  for (const slot of [...(pending.get(sessionId) ?? [])].reverse()) slot.cancel?.()
}

function recordAcceptedPrompt(
  { sessionId, remote }: Submission,
  message: string,
  prompt: string,
  bubble: string | undefined,
  disposition: RpcResponseDataMap['prompt']['disposition'] | undefined,
): void {
  useWritingStore.getState().recordPrompt(message)
  if (!bubble) return
  const chat = useChatStore.getState()
  // Older pi versions acknowledge extension commands without a disposition or any run events.
  const legacyCommand =
    remote &&
    !disposition &&
    chat.sessions[sessionId]?.commands.some(
      (c) => c.source === 'extension' && `/${c.name}` === message.split(/\s/, 1)[0],
    )
  // A queued prompt enters the transcript when pi delivers it.
  if (disposition === 'handled' || disposition === 'queued' || legacyCommand)
    chat.promptHandled(sessionId, prompt)
}

/** Present the idle prompt before the first await, including before any file upload. */
export async function sendComposerPrompt(opts: Submission) {
  const { sessionId, draftKey, remote } = opts
  const chat = useChatStore.getState()
  const { text, attachments: submitted } = useDraftsStore.getState().get(draftKey)
  const message = text.trim()
  if (!message && !submitted.length) return
  if (chat.sessions[sessionId]?.isCompacting) return
  const busy = laneBusyNow(sessionId)
  // Idle pi starts this normally. If a turn began in the meantime, queue it
  // once rather than replaying its input hooks after a plain prompt refusal.
  const behavior = busy ? (opts.busyBehavior ?? 'steer') : 'followUp'
  const images = toImageContents(submitted)
  // The Host chooses final document paths. Show filenames until it returns those paths.
  const preview = composePrompt(
    message,
    submitted.map((a) => (a.kind === 'file' && !a.path ? { ...a, path: a.name } : a)),
  )
  const bubble = !busy
    ? chat.addUserMessage(sessionId, preview, images.length ? images : undefined)
    : undefined
  const draftSubmission = takeSubmittedDraft(draftKey, opts.restoreDraftKey)
  const chip = busy ? showPendingChip(sessionId, behavior, preview) : undefined
  let prompt = preview
  const finish = (accepted: boolean) => {
    chip?.remove()
    if (bubble && !accepted) chat.promptHandled(sessionId, prompt)
    draftSubmission.finish(accepted)
  }
  const slot = promptSlot(sessionId, () => finish(false))
  const current = () => !slot.cancelled && draftSubmission.current()
  let accepted = false
  try {
    if (slot.previous) await slot.previous
    if (!current()) return
    if (!canControlSession(sessionId) || sessionTransitionPending(sessionId))
      throw new Error('Lane no longer ready to send.')
    if (remote && submitted.length) {
      if (!opts.remoteAttachments) throw new Error('Attachment upload unavailable.')
      if (submitted.length > 10) throw new Error('At most 10 attachments per message.')
      if (submitted.some((a) => a.kind === 'file'))
        prompt = composePrompt(message, await uploadPromptFiles(sessionId, submitted))
      if (!current()) return
      if (bubble && prompt !== preview) chat.updatePendingPrompt(sessionId, bubble, prompt)
    }
    if (useChatStore.getState().sessions[sessionId]?.isCompacting) throw new Error(COMPACTING_DRAFT)
    chat.setError(sessionId, null)
    const response = await piCallInline(
      sessionId,
      {
        type: 'prompt',
        message: prompt,
        ...(images.length ? { images } : {}),
        streamingBehavior: behavior,
      },
      () => {
        if (!current()) throw new Error('Prompt cancelled before dispatch.')
        slot.dispatch()
        chip?.dispatch(prompt)
      },
    )
    if (!current()) return
    if (!response.ok) {
      chat.setError(
        sessionId,
        response.error.startsWith('Cannot submit a prompt while compaction is in progress')
          ? COMPACTING_DRAFT
          : response.error,
      )
      return
    }
    accepted = true
    recordAcceptedPrompt(opts, message, prompt, bubble, response.data?.disposition)
  } catch (error) {
    if (current()) chat.setError(sessionId, ipcErrorText(error))
  } finally {
    slot.release()
    if (!slot.cancelled) finish(accepted)
  }
}
