import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useExtensionUiStore, type PendingDialog, type Toast } from '@/stores/extensionUi'
import { CloseIcon } from '@/components/icons'
import { ignoreShortcut } from '@/lib/shortcutContext'
import { ModalPanel } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { ansiToSpans, stripAnsi } from '@shared/ansi'
import { CONTEXT_BREAKDOWN_STATUS_KEY } from '@/features/chat/composer/contextBreakdown'
import { RATE_LIMIT_STATUS_KEY } from '@/features/chat/composer/rateLimit'
import { MCP_STATUS_STATUS_KEY, parseMcpStatus, stateLabel } from '@/features/connectors/mcpStatus'
import {
  SUBAGENTS_STATUS_KEY,
  parseSubagentStatus,
  summarizeSubagents,
} from '@/features/chat/subagentStatus'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { CommandApprovalSheet } from './CommandApprovalSheet'
import { parseCommandApproval } from './commandApproval'

/**
 * Extension-authored text styled with ANSI SGR codes, rendered as colored
 * runs. pi extensions style for pi's own TUI; we honor foreground colors and
 * drop everything else rather than letting escape bytes reach the DOM.
 */
function AnsiText({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {ansiToSpans(text).map((span, i) =>
        span.color ? (
          <span key={i} style={{ color: span.color }}>
            {span.text}
          </span>
        ) : (
          <span key={i}>{span.text}</span>
        ),
      )}
    </>
  )
}

/** Modal host for extension dialogs (select / confirm / input / editor). */
export function ExtensionDialogHost(): React.JSX.Element | null {
  const dialog = useExtensionUiStore((s) => s.dialogs[0])
  if (!dialog) return null
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
              <button
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
              </button>
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

/** Toast host (extension notify + app notices). */
export function ToastHost(): React.JSX.Element {
  const toasts = useExtensionUiStore((s) => s.toasts)
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  )
}

function ToastCard({ toast }: { toast: Toast }): React.JSX.Element {
  return (
    <div
      className={clsx(
        'toast-slide pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-lg',
        toast.kind === 'error'
          ? 'bg-danger-soft border-danger/30'
          : toast.kind === 'warning'
            ? 'bg-warning/10 border-warning/30'
            : 'bg-surface-raised border-border',
      )}
    >
      <span
        className={clsx(
          'mt-1 h-2 w-2 shrink-0 rounded-full',
          toast.kind === 'error'
            ? 'bg-danger'
            : toast.kind === 'warning'
              ? 'bg-warning'
              : 'bg-info',
        )}
      />
      <span className="text-text min-w-0 flex-1 text-base leading-snug">
        {stripAnsi(toast.message)}
      </span>
      <button
        onClick={() => useExtensionUiStore.getState().dismissToast(toast.id)}
        className="text-text-tertiary hover:text-text shrink-0"
      >
        <CloseIcon size={11} strokeWidth={2.5} />
      </button>
    </div>
  )
}

/**
 * Status keys this strip must not render: they carry structured payloads for a
 * specific component rather than a human-readable line. `setStatus` is pi's
 * only channel for pushing extension state to the front-end, so it doubles as
 * a data bus — a status the strip doesn't recognise as prose belongs to
 * whichever component parses it.
 */
const STRUCTURED_STATUS_KEYS = new Set([
  CONTEXT_BREAKDOWN_STATUS_KEY,
  RATE_LIMIT_STATUS_KEY,
  MCP_STATUS_STATUS_KEY,
  SUBAGENTS_STATUS_KEY,
])

/**
 * MCP state as a chip, not as the adapter's sentence.
 *
 * The adapter's own footer text is prose ("3 servers enabled (2 connected)")
 * and says nothing per server. This renders the structured snapshot instead,
 * and clicking it goes where the user can act on it.
 */
function McpChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const statusText = useExtensionUiStore((s) => s.statuses[sessionId]?.[MCP_STATUS_STATUS_KEY])
  const status = parseMcpStatus(statusText)
  if (!status || status.servers.length === 0) return null
  const attention = status.servers.filter(
    (server) => server.state === 'needs-auth' || server.state === 'failed',
  )
  const enabled = status.servers.filter((server) => server.state !== 'disabled').length

  return (
    <button
      onClick={() => {
        const settings = useSettingsUiStore.getState()
        settings.setTab('connectors')
        settings.setOpen(true)
      }}
      title={status.servers.map((s) => `${s.name}: ${stateLabel(s.state)}`).join('\n')}
      className="text-text-tertiary hover:text-text flex min-w-0 shrink-0 items-center gap-1.5 text-xs"
    >
      <span
        className={clsx(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          attention.length > 0
            ? 'bg-warning'
            : status.connectedCount > 0
              ? 'bg-success'
              : 'bg-info',
        )}
      />
      <span className="truncate">
        MCP {status.connectedCount}/{enabled}
        {status.totalTools > 0 && ` · ${status.totalTools} tools`}
        {attention.length > 0 && ` · ${attention.length} need attention`}
      </span>
    </button>
  )
}

/**
 * Sub-agents as a chip: how many are out there, and what the newest one is
 * doing right now.
 *
 * The provider clears this key when the episode ends (0.4.14), so the chip is
 * live state and disappears with the turn — the transcript's own agent rows
 * are what remain. On an older provider the key is never cleared, which is
 * why the chip says "done" rather than "running" once nothing is active.
 */
function SubagentChip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const statusText = useExtensionUiStore((s) => s.statuses[sessionId]?.[SUBAGENTS_STATUS_KEY])
  const snapshot = parseSubagentStatus(statusText)
  if (!snapshot) return null
  return (
    <span
      data-testid="subagent-chip"
      title={snapshot.tasks
        .map((task) => `${task.description || task.taskId}: ${task.status}`)
        .join('\n')}
      className="text-text-tertiary flex min-w-0 items-center gap-1.5 text-xs"
    >
      <span
        className={clsx(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          snapshot.active > 0 ? 'bg-accent' : 'bg-text-tertiary/50',
        )}
      />
      <span className="truncate">{summarizeSubagents(snapshot)}</span>
    </span>
  )
}

/** Status strip entries for a session (extension setStatus). */
export function StatusStrip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const statuses = useExtensionUiStore((s) => s.statuses[sessionId])
  if (!statuses) return null
  const entries = Object.entries(statuses).filter(([key]) => !STRUCTURED_STATUS_KEYS.has(key))
  const hasMcp = statuses[MCP_STATUS_STATUS_KEY] !== undefined
  const hasAgents = statuses[SUBAGENTS_STATUS_KEY] !== undefined
  if (entries.length === 0 && !hasMcp && !hasAgents) return null
  return (
    <div className="border-border bg-bg-secondary/60 flex h-6 shrink-0 items-center gap-3 border-t px-3">
      <McpChip sessionId={sessionId} />
      <SubagentChip sessionId={sessionId} />
      {entries.map(([key, text]) => (
        <span
          key={key}
          title={stripAnsi(text)}
          className="text-text-tertiary flex min-w-0 items-center gap-1.5 text-xs"
        >
          <span className="bg-info h-1.5 w-1.5 shrink-0 rounded-full" />
          <span className="truncate">
            <AnsiText text={text} />
          </span>
        </span>
      ))}
    </div>
  )
}

/** Composer widget slots (extension setWidget). */
export function WidgetSlot({
  sessionId,
  placement,
}: {
  sessionId: string
  placement: 'aboveEditor' | 'belowEditor'
}): React.JSX.Element | null {
  const widgets = useExtensionUiStore((s) => s.widgets[sessionId])
  const entries = Object.entries(widgets ?? {}).filter(([, w]) => w.placement === placement)
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
