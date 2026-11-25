import { ipcErrorText } from '@shared/errors'
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
  remote: boolean
  remoteAttachments: boolean
  /** How the message goes while the lane is busy; Enter and Send steer. Unused while idle. */
  busyBehavior?: 'followUp' | 'steer'
}
export const COMPACTING_DRAFT = 'Compaction in progress. Send your draft when it finishes.'

/** Preserve send order across document uploads, not across pi replies. */
const pending = new Map<string, Promise<void>>()

function promptSlot(key: string) {
  const previous = pending.get(key)
  let done!: () => void
  const tail = new Promise<void>((resolve) => {
    done = resolve
  })
  pending.set(key, tail)
  return {
    previous,
    release() {
      if (pending.get(key) === tail) pending.delete(key)
      done()
    },
  }
}

/** Present the idle prompt before the first await, including before any file upload. */
export async function sendComposerPrompt(opts: Submission) {
  const { sessionId, draftKey, remote } = opts
  const chat = useChatStore.getState()
  const drafts = useDraftsStore.getState()
  const draft = drafts.get(draftKey)
  const message = draft.text.trim()
  if (!message && !draft.attachments.length) return
  if (chat.sessions[sessionId]?.isCompacting) return
  const busy = laneBusyNow(sessionId)
  // Idle pi starts this normally. If a turn began in the meantime, queue it
  // once rather than replaying its input hooks after a plain prompt refusal.
  const behavior = busy ? (opts.busyBehavior ?? 'steer') : 'followUp'
  const submitted = draft.attachments
  const images = toImageContents(submitted)
  // The Host chooses final document paths. Show filenames until it returns those paths.
  const preview = composePrompt(
    message,
    submitted.map((a) => (a.kind === 'file' && !a.path ? { ...a, path: a.name } : a)),
  )
  const bubble = !busy
    ? chat.addUserMessage(sessionId, preview, images.length ? images : undefined)
    : undefined
  const finishDraft = takeSubmittedDraft(draftKey)
  const hideChip = busy ? showPendingChip(sessionId, behavior, preview) : undefined
  const slot = promptSlot(sessionId)
  let prompt = preview
  let accepted = false
  try {
    if (slot.previous) await slot.previous
    if (!canControlSession(sessionId) || sessionTransitionPending(sessionId))
      throw new Error('Lane no longer ready to send.')
    if (remote && submitted.length) {
      if (!opts.remoteAttachments) throw new Error('Attachment upload unavailable.')
      if (submitted.length > 10) throw new Error('At most 10 attachments per message.')
      if (submitted.some((a) => a.kind === 'file'))
        prompt = composePrompt(message, await uploadPromptFiles(sessionId, submitted))
      if (bubble && prompt !== preview) chat.updatePendingPrompt(sessionId, bubble, prompt)
    }
    if (useChatStore.getState().sessions[sessionId]?.isCompacting) throw new Error(COMPACTING_DRAFT)
    chat.setError(sessionId, null)
    const receipt = piCallInline(sessionId, {
      type: 'prompt',
      message: prompt,
      ...(images.length ? { images } : {}),
      streamingBehavior: behavior,
      ...(busy ? { busy: true as const } : {}),
    })
    slot.release()
    const response = await receipt
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
    useWritingStore.getState().recordPrompt(message)
    // Older pi versions acknowledge extension commands without a disposition or any run events.
    const legacyCommand =
      remote &&
      !response.data?.disposition &&
      chat.sessions[sessionId]?.commands.some(
        (c) => c.source === 'extension' && `/${c.name}` === message.split(/\s/, 1)[0],
      )
    // A queued prompt, like a steer, enters the transcript when pi delivers it.
    const disposition = response.data?.disposition
    if (bubble && (disposition === 'handled' || disposition === 'queued' || legacyCommand))
      chat.promptHandled(sessionId, prompt)
  } catch (error) {
    chat.setError(sessionId, ipcErrorText(error))
  } finally {
    slot.release()
    hideChip?.()
    if (bubble && !accepted) chat.promptHandled(sessionId, prompt)
    finishDraft(accepted)
  }
}
