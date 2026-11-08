import type { BrainLearningTarget } from '@shared/brain-learning-jobs'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { hasDelegatedWork, SUBAGENT_ASYNC_WIDGET_KEY } from '@/features/chat/subagentRuns'
import { useLearningUi } from './learningUi'

/** Rechecks known source activity while consent is open; backend still owns authority. */
export function useLearningSourceBusy(target: BrainLearningTarget): boolean {
  const source = useSessionsStore((s) =>
    Object.values(s.live).find((live) => live.diskPath === target.sessionPath),
  )
  const unavailable = useSessionsStore(
    (s) =>
      s.opening?.path === target.sessionPath ||
      s.deletingSessionKeys.includes(target.sessionPath) ||
      !!s.bulkDelete?.running,
  )
  const streaming = useChatStore((s) => {
    const chat = source ? s.sessions[source.phosphorId] : undefined
    return !!chat && (chat.isStreaming || (chat.promptSentAt != null && !chat.error))
  })
  const delegated = useExtensionUiStore((s) =>
    source
      ? hasDelegatedWork(s.widgets[source.phosphorId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
      : false,
  )
  const privateSource = useLearningUi((s) =>
    s.jobs.some((job) => !!job.learning && job.sessionPath === target.sessionPath),
  )
  return (
    unavailable ||
    streaming ||
    delegated ||
    privateSource ||
    source?.target?.kind === 'remote' ||
    !target.workspacePath ||
    !target.sessionPath
  )
}
