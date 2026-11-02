import { useCallback, useEffect, useState } from 'react'
import type { GlobalInstructions } from '@shared/global-instructions'
import { errorText } from '@shared/errors'
import { useExtensionUiStore } from '@/stores/extensionUi'
import type { InstructionsSource } from './instructionsSource'

export interface InstructionsFile {
  /** As last read or saved; null until the first read succeeds. */
  file: GlobalInstructions | null
  draft: string
  setDraft: (text: string) => void
  dirty: boolean
  saving: boolean
  /** The last read or save failure, cleared by the next attempt. */
  error: string | null
  save: () => Promise<void>
  /** Read the file again, dropping the draft. */
  reload: () => Promise<void>
}

/**
 * One machine's instructions file as the editor holds it. `source` must be
 * stable (memoized by the caller): a new one reads the file again.
 *
 * A save names the revision the draft was opened at, so a file changed
 * elsewhere in the meantime is refused rather than overwritten; the user
 * reloads it and edits again.
 */
export function useInstructionsFile(source: InstructionsSource): InstructionsFile {
  const [file, setFile] = useState<GlobalInstructions | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const next = await source.read()
      setFile(next)
      setDraft(next.content)
    } catch (failure) {
      setError(errorText(failure))
    }
  }, [source])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = async (): Promise<void> => {
    if (!file || saving || draft === file.content) return
    setSaving(true)
    setError(null)
    try {
      setFile(await source.save(draft, file.revision))
      useExtensionUiStore
        .getState()
        .pushToast(
          `Saved on ${source.machine}. Running lanes use it from their next message.`,
          'info',
        )
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSaving(false)
    }
  }

  return {
    file,
    draft,
    setDraft,
    dirty: file !== null && draft !== file.content,
    saving,
    error,
    save,
    reload,
  }
}
