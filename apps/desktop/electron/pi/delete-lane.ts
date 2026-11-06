import { createSessionDeletion } from '@phosphor/session-runtime/pi/session-deletion'
import {
  assertNoBrainControl,
  assertNotBrainSource,
} from '@phosphor/session-runtime/pi/brain-session-admission'
import { registry } from '../registry'
import { clearDraft } from '../store'
import { deleteDraftBlobs } from '../drafts-blobs'
import { forgetSpawnAccount } from './session-accounts'
import { deleteSession } from './session-deleter'
import { sessionPaths } from './session-path-lock'
import { isRoutineSession } from '../routines/ownership'

/** The runtime stops writers; Desktop retains its existing Trash and draft policy. */
export const deleteLane = createSessionDeletion({
  registry,
  paths: sessionPaths,
  ownsRoutine: isRoutineSession,
  cancelRoutine: async (id) => {
    const { cancelRoutineSession } = await import('../routines')
    await cancelRoutineSession(id)
  },
  forgetAccount: forgetSpawnAccount,
  assertDeletable: (id) => {
    const live = registry.get(id)
    if (live) assertNoBrainControl(live)
  },
  deleteTranscript: async (path) => {
    await assertNotBrainSource(path, process.cwd(), registry)
    await deleteSession(path)
  },
  deleteDraft: async (path) => {
    await deleteDraftBlobs(clearDraft(`session:${path}`))
  },
})
