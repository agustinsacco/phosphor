import { useState } from 'react'
import type { BrainStatus } from '@shared/brain'
import type { BrainTidyAction, BrainTidyPage, BrainTidySuggestionDetail } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import { brainToast, mutateBrain, useBrain } from '../useBrain'
import type { TidySelection } from './TidyList'
import { tidyChangeToast } from './tidyActions'

export function useTidyActions({
  detail,
  page,
  reload,
  retryDetail,
  retryChanges,
  selectNext,
  selected,
}: {
  detail: BrainTidySuggestionDetail | null
  page: BrainTidyPage | null
  reload: () => Promise<BrainTidyPage | null>
  retryDetail: () => void
  retryChanges: () => void
  selectNext: () => void
  selected: TidySelection
}) {
  const { message, busy, perform } = useTidyMutation({
    reload,
    retryDetail,
    retryChanges,
    selectNext,
    selected,
  })
  const apply = (action: BrainTidyAction): void => {
    if (!detail) return
    void perform(
      async () => {
        const result = await window.phosphor.invoke(
          'brain:tidyApply',
          detail.suggestion.id,
          action,
          detail.revision,
        )
        tidyChangeToast(
          result,
          action.kind === 'forget'
            ? 'Memory permanently forgotten'
            : action.kind === 'keep'
              ? 'Memory kept'
              : 'Brain updated',
        )
        return result
      },
      detail.revision,
      true,
    )
  }
  const dismiss = (): void => {
    if (!detail) return
    void perform(
      async () => {
        const result = await window.phosphor.invoke(
          'brain:tidyDismiss',
          detail.suggestion.id,
          detail.revision,
        )
        brainToast('Suggestion dismissed')
        return result
      },
      detail.revision,
      true,
    )
  }
  const undo = (id: string): void => {
    if (!page) return
    void perform(async () => {
      const result = await window.phosphor.invoke('brain:tidyUndo', id, page.revision)
      brainToast('Change undone')
      return result
    }, page.revision)
  }
  const run = (cancel = false): void => {
    void perform(
      () => window.phosphor.invoke(cancel ? 'brain:tidyCancel' : 'brain:tidyRun'),
      page?.revision ?? 0,
    )
  }
  return { message, busy, apply, dismiss, undo, run }
}

function useTidyMutation({
  reload,
  retryDetail,
  retryChanges,
  selectNext,
  selected,
}: Pick<
  Parameters<typeof useTidyActions>[0],
  'reload' | 'retryDetail' | 'retryChanges' | 'selectNext' | 'selected'
>) {
  const [message, setMessage] = useState('')
  const busy = useBrain((s) => s.saving)
  const perform = async (
    call: () => Promise<BrainStatus>,
    revision: number,
    advance = false,
  ): Promise<void> => {
    setMessage('')
    try {
      await mutateBrain(call)
      if (advance) selectNext()
      await reload()
      retryChanges()
    } catch (cause) {
      const fresh = await reload()
      retryDetail()
      retryChanges()
      if (
        fresh &&
        selected?.type === 'suggestion' &&
        !fresh.items.some((s) => s.id === selected.id)
      ) {
        setMessage('This suggestion was already settled.')
        selectNext()
      } else
        setMessage(
          fresh && fresh.revision !== revision
            ? 'Brain changed. Check this again.'
            : ipcErrorText(cause),
        )
    }
  }
  return { message, busy, perform }
}
