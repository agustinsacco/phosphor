import { useState } from 'react'
import type { BrainStatus } from '@shared/brain'
import type { BrainTidyAction, BrainTidyPage, BrainTidySuggestionDetail } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import { brainToast, mutateBrain, useBrain } from '../useBrain'
import type { TidySelection } from './TidyList'
import type { TidyDetailRead } from './useTidyDetail'
import { tidyChangeToast } from './tidyActions'

export function useTidyActions({
  detail,
  page,
  reload,
  reloadDetail,
  retryChanges,
  selectNext,
  selected,
}: {
  detail: BrainTidySuggestionDetail | null
  page: BrainTidyPage | null
  reload: () => Promise<BrainTidyPage | null>
  reloadDetail: () => Promise<TidyDetailRead>
  retryChanges: () => void
  selectNext: (page: BrainTidyPage | null) => void
  selected: TidySelection
}) {
  const { message, busy, perform } = useTidyMutation({
    reload,
    reloadDetail,
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
  reloadDetail,
  retryChanges,
  selectNext,
  selected,
}: Pick<
  Parameters<typeof useTidyActions>[0],
  'reload' | 'reloadDetail' | 'retryChanges' | 'selectNext' | 'selected'
>) {
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const saving = useBrain((s) => s.saving)
  const perform = async (
    call: () => Promise<BrainStatus>,
    revision: number,
    advance = false,
  ): Promise<void> => {
    setMessage('')
    setPending(true)
    try {
      await mutateBrain(call)
      const fresh = await reload()
      if (advance) selectNext(fresh)
      retryChanges()
    } catch (cause) {
      const fresh = await reload()
      const read = selected?.type === 'suggestion' ? await reloadDetail() : null
      retryChanges()
      if (read?.ok && read.value?.suggestion.state !== 'open') {
        setMessage('This suggestion was already settled.')
        selectNext(fresh)
      } else if (read && !read.ok && read.error) setMessage(read.error)
      else {
        const currentRevision = read?.ok ? read.value?.revision : fresh?.revision
        setMessage(
          currentRevision !== undefined && currentRevision !== revision
            ? 'Brain changed. Check this again.'
            : ipcErrorText(cause),
        )
      }
    } finally {
      setPending(false)
    }
  }
  return { message, busy: saving || pending, perform }
}
