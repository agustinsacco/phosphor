import { useCallback, useLayoutEffect, useRef } from 'react'
import {
  continueList,
  indentSelection,
  pasteIntoList,
  toggleList,
  wrapCodeBlock,
  wrapSelection,
  type ListKind,
  type TextEdit,
} from '@/lib/composerText'
import { COMPOSER_MAX_HEIGHT, useAutoResizeTextarea } from '@/lib/useAutoResizeTextarea'
import { recordTextareaEdit } from '@/lib/textareaUndo'

/**
 * The composer textarea, shared by the chat composer and the home composer.
 *
 * It owns autogrow, the markdown list keymap, and paste. Everything above it
 * in the key order — the `/` and `@` popups, ⇧Tab mode cycling, ↑/↓ prompt
 * recall — stays with the caller, which reports back through `onKeyDown`
 * whether it consumed the event.
 *
 * **Enter always sends.** List continuation is on ⇧Enter, the key that already
 * meant "another line". Binding it to Enter would mean a one-line prompt that
 * happens to start with "- " no longer sends, which is a much worse trade than
 * the one it buys.
 */

export interface ComposerFieldProps {
  value: string
  /** Caret comes along because the caller's `@`-mention regex needs it. */
  onChange: (value: string, caret: number) => void
  onSubmit: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  /** Runs first. Return true when the key was consumed. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Runs last, for keys neither the caller nor the keymap claimed. */
  onKeyDownFallthrough?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  /** Files pasted or dropped; text pastes never reach it. */
  onPasteFiles: (files: File[]) => void
  placeholder: string
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  className?: string
  rows?: number
  'data-testid'?: string
}

export interface FormattingCommands {
  toggleBullet: () => void
  toggleOrdered: () => void
  codeBlock: () => void
  bold: () => void
  italic: () => void
}

/**
 * Formatting commands bound to a textarea.
 *
 * Reads the live value off the DOM node rather than from React state: the node
 * is controlled, so the two agree, and this way the toolbar and the keymap
 * cannot disagree about where the caret is.
 */
export function useComposerFormatting(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  onChange: (value: string, caret: number) => void,
): FormattingCommands & { apply: (edit: TextEdit | null) => boolean } {
  // React re-renders with the new value before the caret can be restored, so
  // the wanted selection is parked here and applied in the layout effect.
  const pendingSelection = useRef<{ start: number; end: number } | null>(null)

  useLayoutEffect(() => {
    const el = textareaRef.current
    const pending = pendingSelection.current
    if (!el || !pending) return
    pendingSelection.current = null
    el.setSelectionRange(pending.start, pending.end)
  })

  const apply = useCallback(
    (edit: TextEdit | null): boolean => {
      if (!edit) return false
      pendingSelection.current = { start: edit.selectionStart, end: edit.selectionEnd }
      if (textareaRef.current) recordTextareaEdit(textareaRef.current, edit.value)
      onChange(edit.value, edit.selectionStart)
      textareaRef.current?.focus()
      return true
    },
    [onChange, textareaRef],
  )

  const run = useCallback(
    (fn: (value: string, from: number, to: number) => TextEdit | null): void => {
      const el = textareaRef.current
      if (!el) return
      apply(fn(el.value, el.selectionStart, el.selectionEnd))
    },
    [apply, textareaRef],
  )

  const toggle = useCallback(
    (kind: ListKind) => run((v, from, to) => toggleList(v, from, to, kind)),
    [run],
  )

  return {
    apply,
    toggleBullet: () => toggle('bullet'),
    toggleOrdered: () => toggle('ordered'),
    codeBlock: () => run(wrapCodeBlock),
    bold: () => run((v, from, to) => wrapSelection(v, from, to, '**')),
    italic: () => run((v, from, to) => wrapSelection(v, from, to, '_')),
  }
}

export function ComposerField({
  value,
  onChange,
  onSubmit,
  onKeyDown,
  onKeyDownFallthrough,
  onPasteFiles,
  placeholder,
  textareaRef,
  className,
  rows = 1,
  'data-testid': testId,
}: ComposerFieldProps): React.JSX.Element {
  useAutoResizeTextarea(textareaRef, value, COMPOSER_MAX_HEIGHT)
  const format = useComposerFormatting(textareaRef, onChange)
  const composing = useRef(false)

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Candidate confirmation must not send, accept a popup, recall history or abort.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return
    if (onKeyDown?.(event)) return

    const el = event.currentTarget
    const mod = event.metaKey || event.ctrlKey

    // ⇧Enter continues the list instead of dropping a bare newline.
    if (event.key === 'Enter' && event.shiftKey && !mod && !event.altKey) {
      if (
        el.selectionStart === el.selectionEnd &&
        format.apply(continueList(el.value, el.selectionStart))
      ) {
        event.preventDefault()
        return
      }
    }

    // Tab / ⇧Tab nest and un-nest, but only inside a list — elsewhere Tab has
    // to stay a focus move.
    if (event.key === 'Tab' && !mod && !event.altKey) {
      const edit = indentSelection(
        el.value,
        el.selectionStart,
        el.selectionEnd,
        event.shiftKey ? 'out' : 'in',
      )
      if (format.apply(edit)) {
        event.preventDefault()
        return
      }
    }

    if (mod && !event.altKey) {
      // event.code, not event.key: with Shift held, Digit8 reports as '*'.
      if (event.shiftKey && event.code === 'Digit8') {
        event.preventDefault()
        format.toggleBullet()
        return
      }
      if (event.shiftKey && event.code === 'Digit7') {
        event.preventDefault()
        format.toggleOrdered()
        return
      }
      if (!event.shiftKey && event.code === 'KeyB') {
        event.preventDefault()
        format.bold()
        return
      }
      if (!event.shiftKey && event.code === 'KeyI') {
        event.preventDefault()
        format.italic()
        return
      }
      if (event.shiftKey && event.code === 'KeyC') {
        event.preventDefault()
        format.codeBlock()
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit(event)
      return
    }

    onKeyDownFallthrough?.(event)
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length > 0) {
      event.preventDefault()
      onPasteFiles(files)
      return
    }
    const text = event.clipboardData.getData('text/plain')
    const el = event.currentTarget
    // Multi-line paste inside a list keeps the list going.
    if (el.selectionStart === el.selectionEnd) {
      if (format.apply(pasteIntoList(el.value, el.selectionStart, text))) {
        event.preventDefault()
      }
    }
  }

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(event) =>
        onChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
      }
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composing.current = true
      }}
      onCompositionEnd={() => {
        composing.current = false
      }}
      onPaste={handlePaste}
      placeholder={placeholder}
      rows={rows}
      data-testid={testId}
      className={
        className ??
        'composer-field text-text placeholder:text-text-secondary block w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 pb-1 text-lg outline-none'
      }
    />
  )
}
