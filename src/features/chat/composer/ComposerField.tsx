import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  continueList,
  indentSelection,
  pasteIntoList,
  toggleList,
  wrapCodeBlock,
  wrapLink,
  wrapSelection,
  type ListKind,
  type TextEdit,
} from '@/lib/composerText'
import { COMPOSER_MAX_HEIGHT, useAutoResizeTextarea } from '@/lib/useAutoResizeTextarea'
import { recordTextareaEdit } from '@/lib/textareaUndo'
import { formatShortcut } from '@/lib/shortcuts'
import { FORMATTING_ACTIONS, formattingKeys, type FormattingAction } from './formattingActions'

/**
 * The composer textarea, shared by the chat composer and the home composer.
 *
 * It owns autogrow, the markdown list keymap, and paste. Everything above it
 * in the key order — the `/` and `@` popups and ↑/↓ prompt
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

export type FormattingCommands = Record<FormattingAction, () => void>

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
    inlineCode: () => run((v, from, to) => wrapSelection(v, from, to, '`')),
    link: () => run(wrapLink),
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
  const fieldId = useId()
  const [expanded, setExpanded] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  useAutoResizeTextarea(
    textareaRef,
    value,
    expanded ? Number.MAX_SAFE_INTEGER : COMPOSER_MAX_HEIGHT,
  )
  const format = useComposerFormatting(textareaRef, onChange)
  const composing = useRef(false)
  const toggleExpanded = (): void => {
    setExpanded((current) => !current)
    textareaRef.current?.focus()
  }

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
      if (event.shiftKey && event.code === 'KeyX') {
        event.preventDefault()
        toggleExpanded()
        return
      }
      // Physical codes work with shifted digits and non-US keyboard layouts.
      const binding = FORMATTING_ACTIONS.find(
        (item) => item.code === event.code && item.shift === event.shiftKey,
      )
      if (binding) {
        event.preventDefault()
        format[binding.action]()
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
    <>
      <textarea
        id={fieldId}
        aria-label="Chat message"
        data-composer-input=""
        style={expanded ? { minHeight: 'min(20rem, 50vh)', maxHeight: '50vh' } : undefined}
        ref={textareaRef}
        value={value}
        onChange={(event) =>
          onChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
        }
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composing.current = true
          setIsComposing(true)
        }}
        onCompositionEnd={() => {
          composing.current = false
          setIsComposing(false)
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
      <div
        role="group"
        aria-label="Text formatting"
        className="flex items-center gap-0.5 overflow-x-auto px-2 py-1"
        onMouseDown={(event) => event.preventDefault()}
      >
        <div className="grid min-w-48 max-w-60 flex-1 grid-cols-7 gap-0.5">
          {FORMATTING_ACTIONS.map((binding) => (
            <button
              key={binding.action}
              type="button"
              aria-label={binding.label}
              title={`${binding.label} (${formatShortcut(...formattingKeys(binding))})`}
              disabled={isComposing}
              onClick={() => {
                if (!composing.current) format[binding.action]()
              }}
              className="text-text-secondary hover:bg-bg-secondary hover:text-text flex h-8 min-w-6 items-center justify-center rounded-md font-mono text-base disabled:opacity-40"
            >
              {binding.action === 'link' ? (
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              ) : (
                <span
                  aria-hidden="true"
                  className={
                    binding.action === 'italic'
                      ? 'italic'
                      : binding.action === 'bold'
                        ? 'font-bold'
                        : undefined
                  }
                >
                  {binding.glyph}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={expanded ? 'Collapse input' : 'Expand input'}
          title={`${expanded ? 'Collapse' : 'Expand'} input (${formatShortcut('mod', 'shift', 'X')})`}
          aria-expanded={expanded}
          aria-controls={fieldId}
          disabled={isComposing}
          onClick={toggleExpanded}
          className="text-text-secondary hover:bg-bg-secondary hover:text-text ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg disabled:opacity-40"
        >
          <span aria-hidden="true">{expanded ? '↙' : '↗'}</span>
        </button>
      </div>
    </>
  )
}
