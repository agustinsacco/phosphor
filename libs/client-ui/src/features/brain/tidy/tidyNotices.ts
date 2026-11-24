import { formatCount } from '@/lib/format'
import type { BrainStatus } from '@shared/brain'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useNotificationsStore } from '@/stores/notifications'
import { brainIsVisible, openBrain } from '../brainNavigation'
import { agentResult } from '../agentStatus'

/** Every Brain notice is about changes, so it opens What changed. */
function notify(message: string, kind: 'info' | 'error' = 'info'): void {
  useExtensionUiStore.getState().notify({
    message,
    key: 'brain',
    kind,
    openLabel: 'Open Brain',
    onOpen: () => openBrain({ changes: true }),
  })
}
function clearBrainNotice(): void {
  const notices = useNotificationsStore.getState()
  notices.items.filter((item) => item.key === 'brain').forEach((item) => notices.remove(item.id))
  const toasts = useExtensionUiStore.getState()
  toasts.toasts
    .filter((item) => item.key === 'brain')
    .forEach((item) => toasts.dismissToast(item.id))
}

/** One Brain notice. Startup is silent; folds during Defrag belong to its result. */
export function createTidyNotices(): (status: BrainStatus | null) => void {
  let previous: BrainStatus | null = null
  return (status) => {
    const before = previous
    previous = status
    if (!status?.supported || !status.prefs.enabled) {
      clearBrainNotice()
      return
    }
    if (!before?.supported || !before.prefs.enabled || before.generation !== status.generation)
      return
    const run = status.agent.run
    const old = before.agent.run
    if (brainIsVisible()) return
    if (
      run &&
      !['queued', 'running'].includes(run.state) &&
      (old?.id !== run.id || old.state === 'queued' || old.state === 'running')
    ) {
      if (run.state === 'failed') notify(run.error ?? 'Defrag failed.', 'error')
      else notify(`${agentResult(run)}${run.state === 'stopped' ? ' · stopped' : ''}`)
      return
    }
    if (run && ['queued', 'running'].includes(run.state)) return
    if (
      status.tidy.automaticFolds > before.tidy.automaticFolds &&
      status.tidy.newestAutomaticFoldAt !== before.tidy.newestAutomaticFoldAt
    )
      notify(
        `Brain folded ${formatCount(status.tidy.automaticFolds - before.tidy.automaticFolds, 'exact repeat')}`,
      )
  }
}
