import { ToastCard } from '@/features/notifications/ToastCard'
import { RemoteLaneControls } from '@/features/machines/RemoteLaneControls'
import { canControlSession, useRemoteLanesStore } from '@/stores/remoteLanes'
import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useExtensionUiStore, type PendingDialog } from '@/stores/extensionUi'
import { useNotificationsStore } from '@/stores/notifications'
import { ignoreShortcut } from '@/lib/shortcutContext'
import { ModalPanel } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { stripAnsi } from '@shared/ansi'
import { SUBAGENT_INSPECT_WIDGET_KEY } from '@/features/chat/subagentRuns'
// From its one home, not the chat re-export: the status-wire audit resolves Set literals one hop deep.
import { SUBAGENT_ASYNC_WIDGET_KEY } from '@phosphor/shared/subagent-fleet'
import { CommandApprovalSheet } from './CommandApprovalSheet'
import { parseCommandApproval } from '@shared/command-approval'
import { AnsiText } from './AnsiText'

/** Modal host for extension dialogs (select / confirm / input / editor). */
export function ExtensionDialogHost(): React.JSX.Element | null {
  useRemoteLanesStore((s) => s.hosts)
  const dialog = useExtensionUiStore((s) => s.dialogs[0])
  if (!dialog) return null
  if (!canControlSession(dialog.sessionId))
    return (
      <div
        role="status"
        className="bg-surface border-border fixed bottom-4 right-4 z-50 max-w-lg rounded border p-4 shadow-lg"
      >
        <p>{dialog.request.title}</p>
        {'message' in dialog.request && <p>{dialog.request.message}</p>}
        {'options' in dialog.request && <p>{dialog.request.options.join(' · ')}</p>}
        <p className="text-text-secondary text-sm">Read-only. Only the controller can answer.</p>
        <RemoteLaneControls sessionId={dialog.sessionId} />
      </div>
    )
  // A permission gate asking to run a command is a review, not a question:
  // the command is the content and the generic sheet rendered it as a title.
  const approval = parseCommandApproval(dialog.request)
  if (approval) {
    return <CommandApprovalSheet key={dialog.request.id} dialog={dialog} approval={approval} />
  }
  return <DialogSheet key={dialog.request.id} dialog={dialog} />
}

function DialogSheet({ dialog }: { dialog: PendingDialog }): React.JSX.Element {
  const { request } = dialog
  const [value, setValue] = useState(request.method === 'editor' ? (request.prefill ?? '') : '')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const resolve = (response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void =>
    useExtensionUiStore.getState().resolveDialog(dialog, response)

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus()
      textareaRef.current?.focus()
    }, 30)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (ignoreShortcut(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        resolve({ cancelled: true })
      }
      if (request.method === 'select') {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSelectedIndex((i) => (i + 1) % request.options.length)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSelectedIndex((i) => (i - 1 + request.options.length) % request.options.length)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          resolve({ value: request.options[selectedIndex] })
        }
      }
      if (request.method === 'confirm') {
        if (event.key === 'Enter') {
          event.preventDefault()
          resolve({ confirmed: true })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, selectedIndex])

  return createPortal(
    <div
      data-shortcut-overlay="extension"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <ModalPanel
        width={480}
        // An extension title is arbitrary text — pi's TUI wraps it, so gates
        // put whole paragraphs there. Cap and scroll rather than letting the
        // panel grow past the top and bottom of the window.
        title={
          <span className="block max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
            {stripAnsi(request.title)}
          </span>
        }
        subtitle="Requested by a pi extension"
        footer={
          <>
            <Button onClick={() => resolve({ cancelled: true })}>Cancel</Button>
            {request.method === 'confirm' && (
              <>
                <Button onClick={() => resolve({ confirmed: false })}>No</Button>
                <Button variant="primary" onClick={() => resolve({ confirmed: true })}>
                  Yes
                </Button>
              </>
            )}
            {(request.method === 'input' || request.method === 'editor') && (
              <Button variant="primary" onClick={() => resolve({ value })}>
                Submit
              </Button>
            )}
            {request.method === 'select' && (
              <Button
                variant="primary"
                onClick={() => resolve({ value: request.options[selectedIndex] })}
              >
                Choose
              </Button>
            )}
          </>
        }
      >
        {request.method === 'select' && (
          <div className="max-h-72 overflow-y-auto py-1.5">
            {request.options.map((option, index) => (
              <TooltipButton
                key={option}
                onMouseMove={() => setSelectedIndex(index)}
                onClick={() => resolve({ value: option })}
                className={clsx(
                  'flex w-full items-center whitespace-pre-wrap break-words px-4 py-2 text-left text-lg transition-colors',
                  index === selectedIndex && 'bg-bg-secondary',
                )}
              >
                {/* Display-only strip: the response echoes the raw option. */}
                {stripAnsi(option)}
              </TooltipButton>
            ))}
          </div>
        )}

        {request.method === 'confirm' && (
          <div className="max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 text-lg">
            {stripAnsi(request.message)}
          </div>
        )}

        {request.method === 'input' && (
          <div className="px-4 py-3">
            <TextInput
              ref={inputRef}
              size="lg"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (!ignoreShortcut(e.nativeEvent) && e.key === 'Enter') resolve({ value })
              }}
              placeholder={request.placeholder}
              className="w-full"
            />
          </div>
        )}

        {request.method === 'editor' && (
          <div className="px-4 py-3">
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={10}
              className="border-border bg-code-bg text-text w-full resize-y rounded-lg border px-3 py-2 font-mono text-base outline-none focus:border-[var(--px-border-strong)]"
            />
          </div>
        )}
      </ModalPanel>
    </div>,
    document.body,
  )
}

/**
 * Notification stack (extension notify, app notices, lane completions).
 *
 * Top-right, hanging just below the title bar: that corner is empty in every
 * layout, it is near where the eye rests on the top bar's session title, and
 * nothing there is covered at the bottom edge where the composer lives.
 *
 * The clocks stop while the pointer is on a card (reading one should not make
 * it vanish mid-sentence) and while the window is in the background (a lane
 * that finishes while you are in another app is still waiting when you come
 * back). Only blur/focus EVENTS pause — an unmapped E2E window never focuses,
 * and reading `document.hasFocus()` at mount would freeze its notices forever.
 */
export function ToastHost(): React.JSX.Element {
  const toasts = useExtensionUiStore((s) => s.toasts)
  const drawerOpen = useNotificationsStore((s) => s.open)
  useEffect(() => {
    const { setToastsPaused } = useExtensionUiStore.getState()
    const onBlur = (): void => setToastsPaused('blur', true)
    const onFocus = (): void => setToastsPaused('blur', false)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      setToastsPaused('blur', false)
      setToastsPaused('hover', false)
    }
  }, [])
  return createPortal(
    // Gaps never swallow a click (each card opts back in). Above anchored popups
    // (`useAnchoredMenu`, z 100), so a notice never lands under an open inspector.
    <ol
      aria-label="Notifications"
      aria-live="polite"
      data-testid="toast-stack"
      className={clsx(
        'pointer-events-none fixed top-12 z-[110] flex w-[22rem] max-w-[calc(100vw-1rem)] flex-col',
        // Beside the open drawer, not over its first rows.
        drawerOpen ? 'right-[calc(var(--px-drawer-width)+0.5rem)]' : 'right-2',
      )}
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </ol>,
    document.body,
  )
}

/**
 * Widget keys this slot must not render: they carry a machine payload for a
 * specific component, the way the structured status keys do. pi-subagents
 * publishes its background-run tree on `subagent-async` as one line of
 * `PI_SUBAGENT_ASYNC_JSON:` (its documented host protocol for RPC clients);
 * printed as lines, that blob filled the space above the composer. Its
 * `subagent-inspect` replies are correlated by request id and, per the same
 * protocol, must never be rendered.
 */
const STRUCTURED_WIDGET_KEYS = new Set([
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_INSPECT_WIDGET_KEY,
  'phosphor-subagent-save',
])

/** Composer widget slots (extension setWidget). */
export function WidgetSlot({
  sessionId,
  placement,
}: {
  sessionId: string
  placement: 'aboveEditor' | 'belowEditor'
}): React.JSX.Element | null {
  const widgets = useExtensionUiStore((s) => s.widgets[sessionId])
  const entries = Object.entries(widgets ?? {}).filter(
    ([key, w]) => w.placement === placement && !STRUCTURED_WIDGET_KEYS.has(key),
  )
  if (entries.length === 0) return null
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 px-1 pb-2">
      {entries.map(([key, widget]) => (
        <div
          key={key}
          className="border-border bg-bg-secondary/70 rounded-lg border px-3 py-1.5 font-mono text-sm leading-relaxed"
        >
          {widget.lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">
              <AnsiText text={line} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
