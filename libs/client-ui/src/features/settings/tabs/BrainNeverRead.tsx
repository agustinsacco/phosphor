import { useState } from 'react'
import type { BrainPrefs } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button, TextInput } from '@/components/form'
import { useBrain } from '@/features/brain/useBrain'

/** Title rules are additive to the individual lane switches, never an allow-list. */
export function BrainNeverRead({
  prefs,
  saving,
  onChange,
}: {
  prefs: BrainPrefs['neverRead']
  saving: boolean
  onChange(value: BrainPrefs['neverRead']): Promise<boolean>
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const title = draft.trim()
  const canAdd =
    !saving &&
    title.length > 0 &&
    title.length <= 80 &&
    prefs.titles.length < 50 &&
    !prefs.titles.some((pattern) => pattern.toLowerCase() === title.toLowerCase())
  const save = async (titles: string[]): Promise<boolean> => {
    try {
      const saved = await onChange({ ...prefs, titles })
      setError(
        saved ? '' : useBrain.getState().error || 'Could not save the title rules. Try again.',
      )
      return saved
    } catch (error) {
      setError(ipcErrorText(error))
      return false
    }
  }
  const add = async (): Promise<void> => {
    if (canAdd && (await save([...prefs.titles, title]))) setDraft('')
  }
  return (
    <div className="border-border space-y-2 border-b py-3 text-sm">
      <p className="font-medium">Never read matching lane titles</p>
      <p className="text-text-secondary">
        Brain skips titles containing these patterns, case-insensitively and not inside longer words
        or numbers. Use the lane menu to switch off an individual lane. Up to 50 patterns, 80
        characters each.
      </p>
      <BrainTitlePatterns
        patterns={prefs.titles}
        saving={saving}
        remove={(index) => {
          void save(prefs.titles.filter((_, i) => index !== i))
        }}
      />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <TextInput
          aria-label="Lane title pattern"
          className="min-w-0 flex-1"
          maxLength={80}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" disabled={!canAdd}>
          Add pattern
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-danger wrap-anywhere">
          {error}
        </p>
      )}
    </div>
  )
}

function BrainTitlePatterns({
  patterns,
  saving,
  remove,
}: {
  patterns: string[]
  saving: boolean
  remove(index: number): void
}): React.JSX.Element {
  return (
    <ul className="space-y-1">
      {patterns.map((pattern, index) => (
        <li key={`${index}:${pattern}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 wrap-anywhere">{pattern}</span>
          <Button disabled={saving} onClick={() => remove(index)}>
            Remove <span className="sr-only">{pattern}</span>
          </Button>
        </li>
      ))}
    </ul>
  )
}
