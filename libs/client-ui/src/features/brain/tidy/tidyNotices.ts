import { formatCount } from '@/lib/format'
import { tidyFindings } from './tidyWording'
import type { BrainStatus } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useNotificationsStore } from '@/stores/notifications'
import { inboxIsVisible, openTidy } from '../brainNavigation'

function notify(message: string, key: string, recent = false, error = false): void {
  useExtensionUiStore.getState().notify({
    message,
    key,
    kind: error ? 'error' : 'info',
    openLabel: recent ? 'Open recent changes' : 'Open Brain Inbox',
    onOpen: () => openTidy(recent),
  })
}

function clearTidyNotices(): void {
  const inbox = useNotificationsStore.getState()
  inbox.items
    .filter((item) => item.key?.startsWith('brain:tidy'))
    .forEach((item) => inbox.remove(item.id))
  const toasts = useExtensionUiStore.getState()
  toasts.toasts
    .filter((item) => item.key?.startsWith('brain:tidy'))
    .forEach((item) => toasts.dismissToast(item.id))
}

/** One observer per shared status subscription. Its first answer is only a baseline. */
export function createTidyNotices(): (status: BrainStatus | null) => void {
  let previous: BrainStatus | null = null
  let request = 0
  return (status) => {
    const before = previous
    previous = status
    if (!status?.supported || !status.prefs.enabled) {
      request++
      clearTidyNotices()
      return
    }
    if (!before?.supported || !before.prefs.enabled || before.generation !== status.generation) {
      request++
      return
    }
    const next = status.tidy,
      old = before.tidy
    if (!old.running && next.running) request++
    if (
      next.automaticFolds > old.automaticFolds &&
      next.newestAutomaticFoldAt !== old.newestAutomaticFoldAt
    )
      notify(
        `Brain folded ${formatCount(next.automaticFolds - old.automaticFolds, 'exact repeat')}`,
        'brain:tidy:folds',
        true,
      )
    if (
      !old.running &&
      !next.running &&
      next.open > old.open &&
      next.newestSuggestionAt !== old.newestSuggestionAt
    )
      notify(`Brain has ${formatCount(next.open, 'thing to tidy', 'things to tidy')}`, 'brain:tidy')
    if (old.running && !next.running && !inboxIsVisible()) {
      const ticket = ++request
      void window.phosphor
        .invoke('brain:tidy', null, null, 1)
        .then((page) => {
          if (ticket !== request || inboxIsVisible() || previous?.generation !== status.generation)
            return
          const run = page.run
          if (run?.state === 'done')
            notify(
              `Brain Tidy ${tidyFindings(run.suggestions, run.folded) ?? 'found nothing to tidy'}.${run.message ? ` ${run.message}` : ''}`,
              'brain:tidy:finished',
            )
          if (run?.state === 'failed')
            notify(
              run.error ?? 'Brain Tidy could not finish. Open the Brain Inbox to retry.',
              'brain:tidy:finished',
              false,
              true,
            )
        })
        .catch((cause: unknown) => {
          if (ticket === request)
            notify(`${ipcErrorText(cause)} Open the Brain Inbox to retry.`, 'brain:tidy:finished', false, true)
        })
    }
  }
}
