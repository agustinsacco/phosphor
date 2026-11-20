import { useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { brainToast, mutateBrain, useBrain } from '../useBrain'

/** Undo a journal entry; a refusal stays beside its action and the list can be retried. */
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
      onChanged()
    } catch (cause) {
      setMessage(ipcErrorText(cause))
    } finally {
      setPending(false)
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
