import { ipcErrorText } from '@shared/errors'
import { piCallAccepted } from '@/lib/rpc'
import { useChatStore } from '@/stores/chat'
import { takeSubmittedDraft, useDraftsStore } from '@/stores/drafts'
import { useWritingStore } from '@/stores/writing'
import { composePrompt, toImageContents, type PendingAttachment } from './attachments'
import { uploadPromptFiles } from './uploadPromptFiles'
import { type createReceiptGuard, withDraftIds } from './receiptGuard'

type Submission = {
  sessionId: string
  draftKey: string
  remote: boolean
  remoteAttachments: boolean
  behavior?: 'followUp' | 'steer'
}

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
  const { sessionId, draftKey, remote, behavior } = opts
  const chat = useChatStore.getState()
  const drafts = useDraftsStore.getState()
  const draft = drafts.get(draftKey)
  const message = draft.text.trim()
  if (
    (!message && !draft.attachments.length) ||
    (!behavior && chat.sessions[sessionId]?.promptSentAt != null)
  )
    return
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
    const response = await piCallAccepted(sessionId, {
      type: 'prompt',
      message: prompt,
      ...(images.length ? { images } : {}),
      ...(behavior ? { streamingBehavior: behavior } : {}),
    })
    if (!response) return
    accepted = true
    useWritingStore.getState().recordPrompt(message)
    // Older pi versions acknowledge extension commands without a disposition or any run events.
    const legacyCommand =
      remote &&
      !response.data?.disposition &&
      chat.sessions[sessionId]?.commands.some(
        (c) => c.source === 'extension' && `/${c.name}` === message.split(/\s/, 1)[0],
      )
    if (bubble && (response.data?.disposition === 'handled' || legacyCommand))
      chat.promptHandled(sessionId, prompt)
  } catch (error) {
    chat.setError(sessionId, ipcErrorText(error))
  } finally {
    queue?.finish(accepted)
    if (bubble && !accepted) chat.promptHandled(sessionId, prompt)
    finishDraft?.(accepted)
  }
}
