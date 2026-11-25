import { ipcErrorText } from '@shared/errors'
import type { RpcCommand } from '@shared/rpc'
import { piCallInline } from '@/lib/rpc'
import { useChatStore } from '@/stores/chat'
import { takeSubmittedDraft, useDraftsStore } from '@/stores/drafts'
import { useWritingStore } from '@/stores/writing'
import { composePrompt, toImageContents, type PendingAttachment } from './attachments'
import { uploadPromptFiles } from './uploadPromptFiles'
import { type createReceiptGuard, withDraftIds } from './receiptGuard'
import { laneBusyNow } from './laneBusy'

type Submission = {
  sessionId: string
  draftKey: string
  remote: boolean
  remoteAttachments: boolean
  /** How the message goes while the lane is busy; Enter and Send steer. Unused while idle. */
  busyBehavior?: 'followUp' | 'steer'
}
type PromptCommand = Extract<RpcCommand, { type: 'prompt' }>

/** pi's refusal of a plain prompt while it is processing. */
const PI_BUSY_REFUSAL = 'Agent is already processing'

/**
 * A plain prompt pi refuses because it is processing goes again, once, as a
 * follow-up: the composer read the lane idle a moment before pi started work.
 */
async function deliverPrompt(sessionId: string, command: PromptCommand) {
  const first = await piCallInline(sessionId, command)
  if (first.ok || command.streamingBehavior || !first.error.includes(PI_BUSY_REFUSAL)) return first
  return piCallInline(sessionId, { ...command, streamingBehavior: 'followUp' })
}

/** pi's own words never reach the user for a busy refusal. */
const notSent = (reason: string): string =>
  reason.includes(PI_BUSY_REFUSAL)
    ? 'The agent is busy and did not take your message.'
    : `Message not sent: ${reason}`

/** Steers and follow-ups stay editable until acknowledged. Never clear a newer draft. */
function queuedDraft(
  key: string,
  images: PendingAttachment[],
  guard: ReturnType<typeof createReceiptGuard>,
  message: string,
) {
  const drafts = useDraftsStore.getState()
  const drafted = withDraftIds(images, true)
  const submitted = guard.fresh(drafted)
  if (guard.isResend(message, submitted)) return null
  const ids = new Set(submitted.map((a) => a.draftAttachmentId))
  const release = guard.hold(message, ids)
  let edited = false
  const off = useDraftsStore.subscribe((s, p) => {
    if (s.drafts[key]?.text !== p.drafts[key]?.text) edited = true
  })
  drafts.setAttachments(key, drafted)
  return {
    submitted,
    finish(success: boolean) {
      off()
      release()
      if (success)
        drafts.patch(key, {
          ...(!edited ? { text: '' } : {}),
          attachments: drafts.get(key).attachments.filter((a) => !ids.has(a.draftAttachmentId)),
        })
    },
  }
}

/** Present the idle prompt before the first await, including before any file upload. */
export async function sendComposerPrompt(
  opts: Submission,
  guard: ReturnType<typeof createReceiptGuard>,
) {
  const { sessionId, draftKey, remote } = opts
  const chat = useChatStore.getState()
  const drafts = useDraftsStore.getState()
  const draft = drafts.get(draftKey)
  const message = draft.text.trim()
  if (!message && !draft.attachments.length) return
  const behavior = laneBusyNow(sessionId) ? (opts.busyBehavior ?? 'steer') : undefined
  const queue =
    remote && behavior ? queuedDraft(draftKey, draft.attachments, guard, message) : undefined
  if (queue === null) return
  const submitted = queue?.submitted ?? draft.attachments
  const images = toImageContents(submitted)
  // The Host chooses final document paths. Show filenames until it returns those paths.
  const preview = composePrompt(
    message,
    submitted.map((a) => (a.kind === 'file' && !a.path ? { ...a, path: a.name } : a)),
  )
  const bubble = !behavior
    ? chat.addUserMessage(sessionId, preview, images.length ? images : undefined)
    : undefined
  const finishDraft = remote && bubble ? takeSubmittedDraft(draftKey) : undefined
  let prompt = preview
  let accepted = false
  try {
    if (!remote) drafts.clear(draftKey)
    if (remote && submitted.length) {
      if (!opts.remoteAttachments) throw new Error('Attachment upload unavailable.')
      prompt = composePrompt(message, await uploadPromptFiles(sessionId, submitted))
      if (bubble && prompt !== preview) chat.updatePendingPrompt(sessionId, bubble, prompt)
    }
    const response = await deliverPrompt(sessionId, {
      type: 'prompt',
      message: prompt,
      ...(images.length ? { images } : {}),
      ...(behavior ? { streamingBehavior: behavior } : {}),
    })
    if (!response.ok) {
      chat.setError(sessionId, notSent(response.error))
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
    chat.setError(sessionId, notSent(ipcErrorText(error)))
  } finally {
    queue?.finish(accepted)
    if (bubble && !accepted) chat.promptHandled(sessionId, prompt)
    finishDraft?.(accepted)
  }
}
