import { useEffect } from 'react'
import { showContextMenuAt, type ContextMenuItem } from '@/components/ContextMenu'
import { formatShortcut } from '@/lib/shortcuts'
import { recordTextareaEdit } from '@/lib/textareaUndo'
import { useWritingStore } from '@/stores/writing'
import { buildTextFieldMenu, type TextFieldAction } from './textFieldMenuItems'

/**
 * The right-click menu of every text field in the app: spelling suggestions
 * for a misspelled word, Add to dictionary, then Cut / Copy / Paste / Select
 * all. Electron shows no menu of its own, so before this a right-click in a
 * text field did nothing at all.
 *
 * One window-level listener rather than a handler per field. It runs last
 * and stands aside when a component already handled the event with its own
 * menu (`showContextMenu` prevents the default), and it skips Monaco and
 * xterm, which take input through hidden textareas of their own.
 */

type TextField = HTMLTextAreaElement | HTMLInputElement

/** Input types whose value is plain text with a selection. Not password. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel'])

function textFieldOf(target: EventTarget | null): TextField | null {
  if (!(target instanceof HTMLElement) || target.closest('.monaco-editor, .xterm')) return null
  if (target instanceof HTMLTextAreaElement) return target.disabled ? null : target
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) {
    return target.disabled ? null : target
  }
  return null
}

function run(field: TextField, selection: [number, number], action: TextFieldAction): void {
  if (action.kind === 'replace') {
    const { start, end, text } = action
    // insertText under the hood: ⌘Z still works, and React sees an input event.
    recordTextareaEdit(field, field.value.slice(0, start) + text + field.value.slice(end))
    return
  }
  if (action.kind === 'learn') {
    void window.phosphor.invoke('writing:learnWord', action.word)
    return
  }
  // The menu button took focus; give the field back its focus and selection
  // so main's edit command lands where the right-click was.
  field.focus()
  field.setSelectionRange(selection[0], selection[1])
  void window.phosphor.invoke('writing:edit', action.command)
}

export function TextFieldMenu(): null {
  useEffect(() => {
    const onContextMenu = (event: MouseEvent): void => {
      if (event.defaultPrevented) return
      const field = textFieldOf(event.target)
      if (!field) return
      const selection: [number, number] = [field.selectionStart ?? 0, field.selectionEnd ?? 0]
      const entries = buildTextFieldMenu(
        {
          value: field.value,
          selectionStart: selection[0],
          selectionEnd: selection[1],
          readOnly: field.readOnly,
          spellcheck: field.spellcheck && useWritingStore.getState().prefs.spellcheck,
        },
        (word) => window.phosphor.spellingSuggestions(word),
      )
      const items: ContextMenuItem[] = entries.map(
        ({ label, action, disabled, separatorAbove, shortcutKey }) => ({
          label,
          disabled: disabled || !action,
          separatorAbove,
          shortcut: shortcutKey ? formatShortcut('mod', shortcutKey) : undefined,
          onClick: () => {
            if (action) run(field, selection, action)
          },
        }),
      )
      event.preventDefault()
      showContextMenuAt(event.clientX, event.clientY, items)
    }
    window.addEventListener('contextmenu', onContextMenu)
    return () => window.removeEventListener('contextmenu', onContextMenu)
  }, [])
  return null
}
