import { ensureServiceLaneControl } from '@/platform/serviceLaneControl'
import { remoteLaneResourceKey } from '@shared/remote-host'
import { archivesChanged } from '@/stores/archiveChanges'
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
  await ensureServiceLaneControl(hostId, laneId)
  try {
    await window.phosphor.invoke('hosts:archiveLane', hostId, laneId)
  } finally {
    archivesChanged(hostId)
  }
}
