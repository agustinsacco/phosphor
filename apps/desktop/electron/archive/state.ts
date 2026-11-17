import { app } from 'electron'
import { join } from 'node:path'
import { isWithinFolder } from '@shared/paths'
import { createLaneArchiveStorage } from '@phosphor/session-runtime/lane-archive/storage'
import { createArchiveInventory } from '@phosphor/session-runtime/lane-archive/inventory'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import { piSessionsRoot } from '../pi/pi-paths'
import { laneAttachmentsDir } from '../lane-move/attachments-dir'

let state: ReturnType<typeof createState> | undefined
function createState() {
  const storage = createLaneArchiveStorage(
    join(app.getPath('userData'), 'lane-archive'),
    piSessionsRoot(),
  )
  const inventory = createArchiveInventory(storage, (record) => {
    const sessionId = record.transcript && /_([0-9a-f-]{36})\.jsonl$/.exec(record.transcript)?.[1]
    return sessionId ? [laneAttachmentsDir(sessionId)] : []
  })
  return { storage, inventory }
}
export const localArchives = () => (state ??= createState())

/** Moving a sandbox would invalidate archived cwd and transcript identities. */
export async function hasArchivedFolder(path: string): Promise<boolean> {
  const { entries, truncated } = await localArchives().storage.list()
  return (
    truncated ||
    entries.some((record) => isWithinFolder(sessionPathKey(record.cwd), sessionPathKey(path)))
  )
}

/** Shared worktrees stay protected even after archived transcripts leave normal discovery. */
export async function assertNoArchivedOwners(cwd: string, except?: string): Promise<void> {
  const { entries, truncated } = await localArchives().storage.list()
  if (
    truncated ||
    entries.some(
      (record) => record.id !== except && sessionPathKey(record.cwd) === sessionPathKey(cwd),
    )
  )
    throw new Error('This checkout still belongs to an archived lane. Clean it up from Archive.')
}
