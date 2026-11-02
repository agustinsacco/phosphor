import { cancelAllPrompts } from '@/stores/prompt'
import { clearRemoteStartMemory } from '@/features/home/remoteComposer'
import { useWorktreesStore } from '@/stores/worktrees'
import { clearDraftMemory } from '@/stores/drafts'
import { clearRoutineMemory } from '@/stores/routines'
import { forgetRemoteSession, useSessionsStore } from '@/stores/sessions'
import { useMachineCataloguesStore } from '@/stores/machineCatalogues'
import { useSkillsStore } from '@/stores/skills'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useStartingChatStore } from '@/stores/startingChat'
import { useMachinesStore } from '@/stores/machines'

let cleanup: Promise<void> = Promise.resolve()
export const waitForCompactCleanup = (): Promise<void> => cleanup

/** A new owner must not mount over the previous owner's in-memory projections. */
export function clearCompactUi(): void {
  useSessionsStore.getState().claimNav()
  cancelAllPrompts()
  clearRemoteStartMemory()
  useWorktreesStore.setState({ preferWorktree: true })
  clearDraftMemory()
  clearRoutineMemory()
  useMachineCataloguesStore.setState({ catalogues: {} })
  useSkillsStore.setState({ byWorkspace: {}, loading: {}, error: {}, selectedDir: null })
  useHomeSubmissionsStore.setState({ pending: {}, warnings: {} })
  useStartingChatStore.setState({ starting: null, draft: null })
  useExtensionUiStore.setState({ toasts: [] })
  useMachinesStore.setState({ view: { kind: 'list' }, adding: false })
  const sessions = Object.values(useSessionsStore.getState().live).filter(
    (entry) => entry.target?.kind === 'remote',
  )
  cleanup = Promise.allSettled(sessions.map((entry) => forgetRemoteSession(entry.phosphorId))).then(
    () => undefined,
  )
}
