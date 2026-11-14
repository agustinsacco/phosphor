import { remoteLaneResourceKey } from '@shared/remote-host'
import { archivesChanged } from '@/stores/archives'
import { useDraftsStore } from '@/stores/drafts'

/** Unsent remote file bytes are memory-only. Do not silently discard them on close. */
export async function archiveRemoteLane(hostId: string, laneId: string): Promise<void> {
  const draft = useDraftsStore.getState().get(remoteLaneResourceKey(hostId, laneId))
  if (
    draft.attachments.some(
      (attachment) => attachment.kind === 'file' && attachment.data !== undefined,
    )
  )
    throw new Error('Send or remove the unsent file attachments before archiving this lane.')
  try {
    await window.phosphor.invoke('hosts:archiveLane', hostId, laneId)
  } finally {
    archivesChanged(hostId)
  }
}
