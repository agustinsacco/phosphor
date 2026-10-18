import type { EditCommand } from '@shared/writing'
import { wordRangeAt } from '@/lib/writing/wordAt'

/**
 * What the right-click menu of a text field offers: spelling suggestions for
 * the word under the pointer, then the edit commands. Pure, so the choices
 * are testable without a DOM; `TextFieldMenu.tsx` runs them.
 */

export interface FieldSnapshot {
  value: string
  selectionStart: number
  selectionEnd: number
  readOnly: boolean
  /** The field allows spellcheck and Settings → Writing has it on. */
  spellcheck: boolean
}

export type TextFieldAction =
  | { kind: 'replace'; start: number; end: number; text: string }
  | { kind: 'learn'; word: string }
  | { kind: 'edit'; command: EditCommand }

export interface TextFieldMenuEntry {
  label: string
  /** Null for an informational row ("No suggestions"). */
  action: TextFieldAction | null
  disabled?: boolean
  separatorAbove?: boolean
  /** Shortcut key with the platform's mod key, for the edit commands. */
  shortcutKey?: string
}

const MAX_SUGGESTIONS = 5

const EDIT_ENTRIES: Array<{ label: string; command: EditCommand; key: string }> = [
  { label: 'Cut', command: 'cut', key: 'X' },
  { label: 'Copy', command: 'copy', key: 'C' },
  { label: 'Paste', command: 'paste', key: 'V' },
  { label: 'Select all', command: 'selectAll', key: 'A' },
]

export function buildTextFieldMenu(
  field: FieldSnapshot,
  suggestionsFor: (word: string) => string[] | null,
): TextFieldMenuEntry[] {
  const entries: TextFieldMenuEntry[] = []

  const range =
    field.spellcheck && !field.readOnly
      ? wordRangeAt(field.value, field.selectionStart, field.selectionEnd)
      : null
  const suggestions = range ? suggestionsFor(range.word) : null
  if (range && suggestions) {
    for (const text of suggestions.slice(0, MAX_SUGGESTIONS)) {
      entries.push({
        label: text,
        action: { kind: 'replace', start: range.start, end: range.end, text },
      })
    }
    if (suggestions.length === 0) {
      entries.push({ label: 'No suggestions', action: null, disabled: true })
    }
    entries.push({ label: 'Add to dictionary', action: { kind: 'learn', word: range.word } })
  }

  const selected = field.selectionStart !== field.selectionEnd
  const disabled: Record<EditCommand, boolean> = {
    cut: !selected || field.readOnly,
    copy: !selected,
    paste: field.readOnly,
    selectAll: field.value === '',
  }
  EDIT_ENTRIES.forEach(({ label, command, key }, index) => {
    entries.push({
      label,
      action: { kind: 'edit', command },
      disabled: disabled[command],
      separatorAbove: index === 0 && entries.length > 0,
      shortcutKey: key,
    })
  })
  return entries
}
