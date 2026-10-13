import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { hostPlatform } from '@/lib/shortcuts'
import { useWritingStore } from '@/stores/writing'
import { FORMATTING_ACTIONS, type FormattingAction } from './formattingActions'

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
 *
 * **Autocomplete** (Settings → Writing) draws its suggestion as ghost text in
 * a mirror layer laid over the textarea, so the textarea stays the only thing
 * that holds text. It shows only with the caret at the end. Tab or → takes it
 * all, ⌥→ (Ctrl+→ off macOS) one word. Esc only hides it, as it only closes
 * a popup: Esc in the composer also stops a running turn, and hiding a
 * suggestion must never do that. The caller vetoes it while a popup, recall
 * or shell command owns the field.
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
  /**
   * Whether an autocomplete suggestion may show now (default true). The
   * Writing setting decides whether there are any at all.
   */
  autocomplete?: boolean
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
 * is controlled, so the two agree, and any caller driving these commands sees
 * the same caret the keymap does.
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
  autocomplete = true,
  placeholder,
  textareaRef,
  className,
  rows = 1,
  'data-testid': testId,
}: ComposerFieldProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
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

  const suggestion = useSuggestion(value, autocomplete && !composing.current)
  const ghost = suggestion.text
  const fieldClass =
    className ??
    'composer-field text-text placeholder:text-text-secondary block w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 pb-1 text-lg outline-none'
  const mirrorRef = useRef<HTMLDivElement>(null)

  // The mirror wraps and scrolls exactly as the textarea does: same classes,
  // plus the textarea's live scroll offset and scrollbar width.
  useLayoutEffect(() => {
    const el = textareaRef.current
    const mirror = mirrorRef.current
    if (!el || !mirror) return
    const style = getComputedStyle(el)
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
    const scrollbar = Math.max(0, el.offsetWidth - el.clientWidth - (borders || 0))
    mirror.style.paddingRight = `${parseFloat(style.paddingRight) + scrollbar}px`
    mirror.scrollTop = el.scrollTop
  })

  const acceptSuggestion = (text: string): void => {
    const next = value + text
    format.apply({ value: next, selectionStart: next.length, selectionEnd: next.length })
  }

  /** Tab / → / ⌥→ / Esc while a suggestion shows. True when the key was used up. */
  const handleSuggestionKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!ghost || event.shiftKey || event.metaKey) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      suggestion.dismiss()
      return true
    }
    const wordKey = hostPlatform() === 'darwin' ? event.altKey : event.ctrlKey
    const plain = !event.altKey && !event.ctrlKey
    if ((event.key === 'Tab' || event.key === 'ArrowRight') && plain) {
      event.preventDefault()
      acceptSuggestion(ghost)
      return true
    }
    if (event.key === 'ArrowRight' && wordKey && !(event.altKey && event.ctrlKey)) {
      event.preventDefault()
      acceptSuggestion(/^\s*\S+/.exec(ghost)?.[0] ?? ghost)
      return true
    }
    return false
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Candidate confirmation must not send, accept a popup, recall history or abort.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return
    if (onKeyDown?.(event)) return
    if (handleSuggestionKey(event)) return

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
    // Positioned by style, not the `relative` class: callers and tests find the
    // composer's drop zone with `closest('div.relative')`.
    <div style={{ position: 'relative' }}>
      {ghost && (
        <div
          ref={mirrorRef}
          aria-hidden="true"
          data-testid="composer-suggestion"
          className={fieldClass}
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
          }}
        >
          <span className="invisible">{value}</span>
          <span className="text-text-tertiary">{ghost}</span>
        </div>
      )}
      <textarea
        aria-label="Chat message"
        data-composer-input=""
        style={{
          // Painted above the mirror, so the caret and selection stay on top.
          position: 'relative',
          ...(expanded ? { minHeight: 'min(20rem, 50vh)', maxHeight: '50vh' } : {}),
        }}
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          suggestion.track(event.target)
          onChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
        }}
        onSelect={(event) => suggestion.track(event.currentTarget)}
        onScroll={(event) => {
          if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop
        }}
        onFocus={(event) => suggestion.track(event.currentTarget)}
        onBlur={suggestion.blur}
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
        className={fieldClass}
      />
    </div>
  )
}

/**
 * The autocomplete suggestion for a field: what to show after the caret, and
 * the focus, caret and dismissal state that decide whether it shows.
 */
function useSuggestion(
  value: string,
  allowed: boolean,
): {
  text: string | null
  track: (el: HTMLTextAreaElement) => void
  blur: () => void
  dismiss: () => void
} {
  const enabled = useWritingStore((s) => s.prefs.autocomplete)
  // Subscribed so the suggestion appears once the learned prompts load.
  useWritingStore((s) => s.ready)
  const [focused, setFocused] = useState(false)
  const [caretAtEnd, setCaretAtEnd] = useState(true)
  /** The value Esc was pressed on; the suggestion stays hidden until it changes. */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)

  useEffect(() => {
    if (enabled) void useWritingStore.getState().load()
  }, [enabled])

  const text =
    enabled && allowed && focused && caretAtEnd && dismissedAt !== value
      ? useWritingStore.getState().predict(value)
      : null

  return {
    text,
    track: (el) => {
      setFocused(true)
      setCaretAtEnd(el.selectionStart === el.selectionEnd && el.selectionEnd === el.value.length)
    },
    blur: () => setFocused(false),
    dismiss: () => setDismissedAt(value),
  }
}
