import { useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { brainToast, mutateBrain, useBrain } from '../useBrain'

/**
 * Undo a journal entry. A refusal stays beside the list, which reloads with Brain's status: the
 * page polls, so upkeep after a read can move Brain past the revision the list was loaded at.
 */
export function useTidyActions(onChanged: () => void) {
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const saving = useBrain((s) => s.saving)
  const perform = async (id: string, revision: number): Promise<void> => {
    setMessage('')
    setPending(true)
    try {
      await mutateBrain(() => window.phosphor.invoke('brain:tidyUndo', id, revision))
      brainToast('Change undone')
    } catch (cause) {
      setMessage(ipcErrorText(cause))
      await useBrain.getState().refresh()
    } finally {
      setPending(false)
      onChanged()
    }
  }
  return {
    message,
    busy: saving || pending,
    undo: (id: string, revision: number): void => {
      void perform(id, revision)
    },
  }
}
