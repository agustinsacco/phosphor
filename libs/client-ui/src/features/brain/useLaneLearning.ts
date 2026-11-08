import { usePlatform } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLearningSourceBusy } from './useLearningSourceBusy'
import type { LaneActionContext } from '@/features/sessions/laneActions'
import { activeLearning, openLearning, useLearningUi } from './learningUi'

export function useLaneLearning(
  workspacePath: string,
  sessionPath: string,
  liveId: string | undefined,
  busy: boolean,
  enrollmentScope = workspacePath,
): {
  learning: LaneActionContext['learning']
  learn: () => void
} {
  const { localBrain } = usePlatform()
  const machine = useRemoteLanesStore((s) => s.filter)
  const source = useSessionsStore((s) => (liveId ? s.live[liveId] : undefined))
  const enrolled = useLearningUi((s) => s.enabled && s.workspaces.includes(enrollmentScope))
  const privateSource = useLearningUi((s) =>
    s.jobs.some((job) => !!job.learning && job.sessionPath === sessionPath),
  )
  const localSource =
    localBrain &&
    enrolled &&
    (machine === 'all' || machine === 'local') &&
    source?.target?.kind !== 'remote'
  const ready = !!workspacePath && !!sessionPath
  const activeJob = useLearningUi((s) => s.jobs.some(activeLearning))
  const sourceBusy = useLearningSourceBusy({ workspacePath, sessionPath })
  const learning = {
    localSource,
    ready,
    private: privateSource,
    busy: busy || activeJob || sourceBusy,
  }
  const learn = (): void => {
    const currentMachine = useRemoteLanesStore.getState().filter
    const policy = useLearningUi.getState()
    if (
      (currentMachine !== 'all' && currentMachine !== 'local') ||
      !policy.enabled ||
      !policy.workspaces.includes(enrollmentScope)
    )
      return
    const live = liveId ? useSessionsStore.getState().live[liveId] : undefined
    if (
      !localSource ||
      !ready ||
      privateSource ||
      busy ||
      live?.target?.kind === 'remote' ||
      useLearningUi.getState().jobs.some(activeLearning)
    )
      return
    if (sourceBusy) return
    openLearning({ workspacePath, sessionPath })
  }
  return { learning, learn }
}
