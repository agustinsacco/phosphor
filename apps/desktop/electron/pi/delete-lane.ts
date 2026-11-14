import { createSessionDeletion } from '@phosphor/session-runtime/pi/session-deletion'
import { registry } from '../registry'
import { clearDraft } from '../store'
import { deleteDraftBlobs } from '../drafts-blobs'
import { forgetSpawnAccount } from './session-accounts'
import { deleteSession } from './session-deleter'
import { sessionPaths } from './session-path-lock'
import { isRoutineSession } from '@phosphor/session-runtime/routines/ownership'

/** Archive and permanent removal share the existing admission/disposal lock domain. */
export function createLaneRemoval(
  deleteTranscript: (path: string) => Promise<void> = deleteSession,
  deleteDraft: (path: string) => Promise<void> = async (path) => {
    await deleteDraftBlobs(clearDraft(`session:${path}`))
  },
) {
  return createSessionDeletion({
    registry: {
      get: registry.get.bind(registry),
      list: registry.list.bind(registry),
      dispose: async (id) => {
        await registry.dispose(id)
        const { ptyManager } = await import('../pty/pty-manager')
        ptyManager.killForSession(id)
      },
    },
    paths: sessionPaths,
    ownsRoutine: isRoutineSession,
    cancelRoutine: async (id) => {
      const { cancelRoutineSession } = await import('../routines')
      await cancelRoutineSession(id)
    },
    forgetAccount: forgetSpawnAccount,
    deleteTranscript,
    deleteDraft,
  })
}
export const deleteLane = createLaneRemoval()
