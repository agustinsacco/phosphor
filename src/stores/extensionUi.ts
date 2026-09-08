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
  kind: 'info' | 'warning' | 'error'
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
  pushToast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  clearSession: (sessionId: string) => void
}

let toastId = 1

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

  pushToast: (message, kind = 'info') => {
    const id = toastId++
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => get().dismissToast(id), 5000)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  clearSession: (sessionId) =>
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
    }),
}))
