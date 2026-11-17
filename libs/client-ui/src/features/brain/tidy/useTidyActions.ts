import { useState } from 'react'
import type { BrainStatus } from '@shared/brain'
import type { BrainTidyAction, BrainTidyPage, BrainTidySuggestionDetail } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import { brainToast, mutateBrain, useBrain } from '../useBrain'
import type { TidyDetailRead } from './useTidyDetail'
import { tidyChangeToast } from './tidyActions'

/**
 * Apply, dismiss, undo and run. A failure reloads rather than replays, and its sentence is
 * returned as `message` so the action bar can show it beside the buttons.
 */
export function useTidyActions({
  detail,
  page,
  reload,
  reloadDetail,
  suggestionId,
  onChanged,
}: {
  detail: BrainTidySuggestionDetail | null
  page: BrainTidyPage | null
  reload: () => Promise<BrainTidyPage | null>
  reloadDetail?: () => Promise<TidyDetailRead>
  suggestionId?: string | null
  /** Recent changes reload after every change. */
  onChanged?: () => void
}) {
  const { message, busy, perform } = useTidyMutation(reload, reloadDetail, suggestionId, onChanged)
  const apply = (action: BrainTidyAction): void => {
    if (!detail) return
    void perform(async () => {
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
    }, detail.revision)
  }
  const dismiss = (): void => {
    if (!detail) return
    void perform(async () => {
      const result = await window.phosphor.invoke(
        'brain:tidyDismiss',
        detail.suggestion.id,
        detail.revision,
      )
      brainToast('Suggestion dismissed')
      return result
    }, detail.revision)
  }
  const undo = (id: string, revision: number): void => {
    void perform(async () => {
      const result = await window.phosphor.invoke('brain:tidyUndo', id, revision)
      brainToast('Change undone')
      return result
    }, revision)
  }
  const run = (cancel = false): void => {
    void perform(
      () => window.phosphor.invoke(cancel ? 'brain:tidyCancel' : 'brain:tidyRun'),
      page?.revision ?? 0,
    )
  }
  return { message, busy, apply, dismiss, undo, run }
}

function useTidyMutation(
  reload: () => Promise<BrainTidyPage | null>,
  reloadDetail: (() => Promise<TidyDetailRead>) | undefined,
  suggestionId: string | null | undefined,
  onChanged: (() => void) | undefined,
) {
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const saving = useBrain((s) => s.saving)
  const perform = async (call: () => Promise<BrainStatus>, revision: number): Promise<void> => {
    setMessage('')
    setPending(true)
    try {
      await mutateBrain(call)
      await reload()
      onChanged?.()
    } catch (cause) {
      const fresh = await reload()
      const read = suggestionId && reloadDetail ? await reloadDetail() : null
      onChanged?.()
      if (read?.ok && read.value?.suggestion.state !== 'open')
        setMessage('This suggestion was already settled.')
      else if (read && !read.ok && read.error) setMessage(read.error)
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
