import { create } from 'zustand'
import type { ExtensionUIRequest } from '@shared/rpc'
import { parseAuthNotice, parseOAuthPrompt } from '@shared/connectors'
import { useConnectorsStore } from './connectors'

export interface PendingDialog {
  sessionId: string
  request: Extract<
    ExtensionUIRequest,
    { method: 'select' } | { method: 'confirm' } | { method: 'input' } | { method: 'editor' }
  >
}

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'success' | 'warning' | 'error'
  /** Bold first line. Absent for the one-line notices most call sites send. */
  title?: string
  /**
   * The session this notice is about. A session holds at most one notice, so
   * a second replaces the first in place, and the notice goes when the user
   * opens the session or it closes.
   */
  sessionId?: string
  /** The lane's marker emoji, so the notice and its sidebar row match. */
  marker?: string
  /** Clicking the card does this (and dismisses it). */
  onOpen?: () => void
  /** Names what clicking does, for the accessible label and the hover hint. */
  openLabel?: string
  /** Playing its exit animation; removed from the list once it finishes. */
  leaving: boolean
  /** Raised when a newer notice replaces this one in place, to replay a pulse. */
  bump: number
}

export type ToastOptions = Pick<
  Toast,
  'message' | 'title' | 'sessionId' | 'marker' | 'onOpen' | 'openLabel'
> & {
  kind?: Toast['kind']
  /** Visible time before auto-dismiss. Defaults by kind; see `toastDuration`. */
  durationMs?: number
}

/** Why the auto-dismiss clocks are stopped. Any one reason stops all of them. */
export type ToastPauseReason = 'hover' | 'blur'

/** Most notices on screen at once. A newer one pushes the oldest out. */
export const MAX_TOASTS = 4
/** Matches `.toast-row[data-leaving]` in index.css. */
export const TOAST_EXIT_MS = 260

/**
 * A notice you can act on stays longer than one that only reports, and an
 * error longer still — both are more expensive to miss.
 */
export function toastDuration(options: Pick<ToastOptions, 'kind' | 'onOpen'>): number {
  if (options.kind === 'error') return 9000
  if (options.onOpen || options.kind === 'warning') return 7000
  return 5000
}

interface ExtensionUiState {
  /** FIFO of dialog requests awaiting a user reply. */
  dialogs: PendingDialog[]
  /** sessionId → statusKey → text. */
  statuses: Record<string, Record<string, string>>
  /** sessionId → widgetKey → widget. */
  widgets: Record<
    string,
    Record<string, { lines: string[]; placement: 'aboveEditor' | 'belowEditor' }>
  >
  toasts: Toast[]

  handleRequest: (sessionId: string, request: ExtensionUIRequest) => void
  resolveDialog: (
    dialog: PendingDialog,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ) => void
  /** A one-line notice. Returns its id. */
  pushToast: (message: string, kind?: Toast['kind']) => number
  /** A notice with a title, a click action or a session. Returns its id. */
  notify: (options: ToastOptions) => number
  /** Start a notice's exit; it leaves the list when the animation is done. */
  dismissToast: (id: number) => void
  /** Dismiss the notice about this session, if there is one. */
  dismissSessionToast: (sessionId: string) => void
  setToastsPaused: (reason: ToastPauseReason, paused: boolean) => void
  clearSession: (sessionId: string) => void
}

let toastId = 1

/**
 * Auto-dismiss clocks, outside the store because nothing renders from them.
 * `remaining` is what is left when the clock is stopped; `startedAt` is when
 * the running stretch began.
 */
const toastClocks = new Map<
  number,
  { remaining: number; startedAt: number; handle?: ReturnType<typeof setTimeout> }
>()
const pauseReasons = new Set<ToastPauseReason>()

function stopClock(id: number): void {
  const clock = toastClocks.get(id)
  if (!clock?.handle) return
  clearTimeout(clock.handle)
  clock.handle = undefined
  clock.remaining = Math.max(0, clock.remaining - (Date.now() - clock.startedAt))
}

function runClock(id: number, dismiss: (id: number) => void): void {
  const clock = toastClocks.get(id)
  if (!clock || clock.handle || pauseReasons.size > 0) return
  clock.startedAt = Date.now()
  clock.handle = setTimeout(() => dismiss(id), clock.remaining)
}

export const useExtensionUiStore = create<ExtensionUiState>((set, get) => ({
  dialogs: [],
  statuses: {},
  widgets: {},
  toasts: [],

  handleRequest: (sessionId, request) => {
    switch (request.method) {
      case 'select':
      case 'confirm':
      case 'editor':
        set((s) => ({ dialogs: [...s.dialogs, { sessionId, request } as PendingDialog] }))
        break

      case 'input': {
        // The MCP adapter asks for OAuth authorization through a plain input
        // prompt. Rendering that raw means a URL the user has to copy by hand,
        // so the connector flow claims it: it opens the browser and shows a
        // card. Deliberately not scoped to the Settings window — the adapter
        // also auto-authenticates mid-turn when a model calls a tool whose
        // server has no token.
        const prompt = parseOAuthPrompt(request.title)
        if (prompt) {
          useConnectorsStore.getState().promptReceived({
            sessionId,
            serverName: prompt.serverName,
            authorizationUrl: prompt.authorizationUrl,
            requestId: request.id,
          })
          break
        }
        set((s) => ({ dialogs: [...s.dialogs, { sessionId, request } as PendingDialog] }))
        break
      }

      case 'notify': {
        // The adapter's own verdict is what tells Phosphor a browser round-trip
        // finished; status snapshots follow later, on reconnect.
        const notice = parseAuthNotice(request.message)
        if (notice) {
          useConnectorsStore.getState().settle(notice.serverName, notice.outcome, notice.detail)
        }
        get().pushToast(request.message, request.notifyType ?? 'info')
        break
      }

      case 'setStatus':
        set((s) => {
          const session = { ...(s.statuses[sessionId] ?? {}) }
          if (request.statusText === undefined || request.statusText === null) {
            delete session[request.statusKey]
          } else {
            session[request.statusKey] = request.statusText
          }
          return { statuses: { ...s.statuses, [sessionId]: session } }
        })
        break

      case 'setWidget':
        set((s) => {
          const session = { ...(s.widgets[sessionId] ?? {}) }
          if (!request.widgetLines) {
            delete session[request.widgetKey]
          } else {
            session[request.widgetKey] = {
              lines: request.widgetLines,
              placement: request.widgetPlacement ?? 'aboveEditor',
            }
          }
          return { widgets: { ...s.widgets, [sessionId]: session } }
        })
        break

      case 'setTitle':
        document.title = request.title ? `${request.title} — Phosphor` : 'Phosphor'
        break

      case 'set_editor_text':
        void import('@/features/chat/uiState').then(({ useChatUiStore }) =>
          useChatUiStore.getState().setPrefill(sessionId, request.text),
        )
        break
    }
  },

  resolveDialog: (dialog, response) => {
    set((s) => ({ dialogs: s.dialogs.filter((d) => d !== dialog) }))
    const payload = response.cancelled
      ? { type: 'extension_ui_response' as const, id: dialog.request.id, cancelled: true as const }
      : response.confirmed !== undefined
        ? {
            type: 'extension_ui_response' as const,
            id: dialog.request.id,
            confirmed: response.confirmed,
          }
        : {
            type: 'extension_ui_response' as const,
            id: dialog.request.id,
            value: response.value ?? '',
          }
    void window.phosphor.invoke('pi:extensionUiResponse', dialog.sessionId, payload)
  },

  pushToast: (message, kind = 'info') => get().notify({ message, kind }),

  notify: (options) => {
    const kind = options.kind ?? 'info'
    const durationMs = options.durationMs ?? toastDuration({ ...options, kind })
    const fields = {
      message: options.message,
      kind,
      title: options.title,
      sessionId: options.sessionId,
      marker: options.marker,
      onOpen: options.onOpen,
      openLabel: options.openLabel,
    }
    // One notice per session: the newer one takes the older one's place (and
    // its clock restarts) rather than stacking a second card for one lane.
    const existing = options.sessionId
      ? get().toasts.find((t) => t.sessionId === options.sessionId && !t.leaving)
      : undefined
    if (existing) {
      stopClock(existing.id)
      toastClocks.set(existing.id, { remaining: durationMs, startedAt: Date.now() })
      set((s) => ({
        toasts: s.toasts.map((t) =>
          t.id === existing.id ? { ...t, ...fields, bump: t.bump + 1 } : t,
        ),
      }))
      runClock(existing.id, get().dismissToast)
      return existing.id
    }
    const id = toastId++
    toastClocks.set(id, { remaining: durationMs, startedAt: Date.now() })
    // Newest first: the stack hangs from the top-right corner, so the newest
    // notice is the one nearest where the eye already is.
    set((s) => ({ toasts: [{ id, ...fields, leaving: false, bump: 0 }, ...s.toasts] }))
    get()
      .toasts.filter((t) => !t.leaving)
      .slice(MAX_TOASTS)
      .forEach((t) => get().dismissToast(t.id))
    runClock(id, get().dismissToast)
    return id
  },

  dismissToast: (id) => {
    const toast = get().toasts.find((t) => t.id === id)
    if (!toast || toast.leaving) return
    stopClock(id)
    toastClocks.delete(id)
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
    // Removed on a timer rather than on `animationend`: reduced motion, a
    // hidden window and jsdom all skip or throttle the animation, and none of
    // them may leave a dismissed notice in the list.
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), TOAST_EXIT_MS)
  },

  dismissSessionToast: (sessionId) => {
    for (const toast of get().toasts) {
      if (toast.sessionId === sessionId) get().dismissToast(toast.id)
    }
  },

  setToastsPaused: (reason, paused) => {
    const wasPaused = pauseReasons.size > 0
    if (paused) pauseReasons.add(reason)
    else pauseReasons.delete(reason)
    const isPaused = pauseReasons.size > 0
    if (wasPaused === isPaused) return
    for (const id of toastClocks.keys()) {
      if (isPaused) stopClock(id)
      else runClock(id, get().dismissToast)
    }
  },

  clearSession: (sessionId) => {
    get().dismissSessionToast(sessionId)
    set((s) => {
      const statuses = { ...s.statuses }
      const widgets = { ...s.widgets }
      delete statuses[sessionId]
      delete widgets[sessionId]
      return {
        statuses,
        widgets,
        dialogs: s.dialogs.filter((d) => d.sessionId !== sessionId),
      }
    })
  },
}))
