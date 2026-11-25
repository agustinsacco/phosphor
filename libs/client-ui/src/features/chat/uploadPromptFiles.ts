import { ensureSessionControl } from '@/platform/serviceLaneControl'
import { remotePromptAttachments, type PendingAttachment } from './attachments'

export async function uploadPromptFiles(sessionId: string, attachments: PendingAttachment[]) {
  return remotePromptAttachments(attachments, async (files) => {
    const claim = ensureSessionControl(sessionId)
    if (claim) await claim
    return window.phosphor.invoke('hosts:uploadAttachments', sessionId, files)
  })
}
