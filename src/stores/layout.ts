import { create } from 'zustand'
import { drop, keyedSlice } from './keyedSlice'
import { useSessionsStore } from './sessions'

export type RightPane = 'files' | 'changes' | 'terminal' | 'artifacts' | null
export type PaneSide = 'left' | 'right'

/**
 * Global full-window surfaces (sidebar → Artifacts / Skills). A page is not a
 * right pane: it belongs to no session, renders over the whole main region,
 * and is reachable from the home screen. Skills lives ONLY here; Artifacts
 * keeps its per-session pane (side-by-side viewing while the model iterates)
 * and the page is the cross-session index.
 */
export type GlobalPage = 'artifacts' | 'skills'

const PANE_IDS = ['files', 'changes', 'terminal', 'artifacts'] as const

/** Float-pane layout for ONE chat session. */
interface SessionPanes {
  pane: RightPane
  /** Fullscreen (↗) overlays the whole main region; the split underneath is untouched. */
  expanded: boolean
  /** Which side of the chat the float pane sits on. */
  side: PaneSide
  /** Pane share of the split, percent. */
  size: number
}

const DEFAULT_PANES: SessionPanes = { pane: null, expanded: false, side: 'right', size: 45 }

/**
 * Slice helpers over `bySession`. The empty value (a closed pane) is shared and
 * frozen, so selectors don't allocate a new object per render.
 */
const panes = keyedSlice<SessionPanes>({ ...DEFAULT_PANES })

/**
 * Pane layout state, keyed per session and persisted to localStorage.
 *
 * Per session, not global or per workspace. It used to be global, which meant
 * opening a terminal in one session opened it in every session you switched
 * to — and because the pane auto-spawns a shell on first open, merely visiting
 * another session silently forked a login shell there. Split sizes then lived
 * in react-resizable-panels' per-WORKSPACE autoSaveId, so lanes fought over
 * one saved size and the old expand-by-resize corrupted it for every session
 * in the workspace. Sessions own their terminals and artifacts, so they own
 * the pane that shows them — selection, side, size and fullscreen alike.
 *
 * Actions take an optional `sessionId` and otherwise resolve the active session
 * themselves, so shortcut/palette/toolbar call sites stay one-liners.
 */
interface LayoutState {
  sidebarVisible: boolean
  /**
   * Open global page, or null. Deliberately NOT per session and NOT
   * persisted: it is app-level navigation, and any session activation
   * (clicking a lane, New) closes it — see `activate` in stores/sessions.ts.
   */
  page: GlobalPage | null
  /** session id → that session's float-pane layout. */
  bySession: Record<string, SessionPanes>
  toggleSidebar: () => void
  setPage: (page: GlobalPage | null) => void
  togglePage: (page: GlobalPage) => void
  setRightPane: (pane: RightPane, sessionId?: string) => void
  toggleRightPane: (pane: Exclude<RightPane, null>, sessionId?: string) => void
  toggleRightExpanded: (sessionId?: string) => void
  togglePaneSide: (sessionId?: string) => void
  setPaneSize: (size: number, sessionId?: string) => void
  /** Drop a disposed session's pane state so the map doesn't grow forever. */
  removeSession: (sessionId: string) => void
}

/** A session's pane layout; closed for unknown/absent sessions. */
export function sessionPanes(
  state: LayoutState,
  sessionId: string | null | undefined,
): SessionPanes {
  return panes.read(state.bySession, sessionId)
}

const STORAGE_KEY = 'phosphor-pane-layout'

/**
 * Validate a persisted `bySession` map field by field. localStorage survives
 * schema changes and hand edits, so every field falls back to its default
 * rather than trusting the stored shape.
 */
export function sanitizePersistedPanes(raw: unknown): Record<string, SessionPanes> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SessionPanes> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const p = value as Partial<SessionPanes>
    out[id] = {
      pane: PANE_IDS.includes(p.pane as (typeof PANE_IDS)[number]) ? p.pane! : null,
      expanded: p.expanded === true,
      side: p.side === 'left' ? 'left' : 'right',
      size:
        typeof p.size === 'number' && Number.isFinite(p.size) && p.size >= 15 && p.size <= 90
          ? p.size
          : DEFAULT_PANES.size,
    }
  }
  return out
}

function loadPersisted(): Record<string, SessionPanes> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    return raw ? sanitizePersistedPanes(JSON.parse(raw)) : {}
  } catch {
    return {}
  }
}

// Debounced: drag-resize streams onResize events, and one trailing write per
// gesture is plenty for ~70 bytes per session.
let persistTimer: ReturnType<typeof setTimeout> | undefined
function schedulePersist(bySession: Record<string, SessionPanes>): void {
  if (typeof globalThis.localStorage === 'undefined') return
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(bySession))
    } catch {
      // Quota/serialization failures just lose layout memory, nothing else.
    }
  }, 150)
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sidebarVisible: true,
  page: null,
  bySession: loadPersisted(),

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),

  setPage: (page) => set({ page }),

  togglePage: (page) => set((state) => ({ page: state.page === page ? null : page })),

  setRightPane: (pane, sessionId) =>
    set((state) => patch(state, sessionId, (current) => ({ ...current, pane }))),

  toggleRightPane: (pane, sessionId) =>
    set((state) =>
      patch(state, sessionId, (current) => ({
        ...current,
        pane: current.pane === pane ? null : pane,
      })),
    ),

  toggleRightExpanded: (sessionId) =>
    set((state) =>
      patch(state, sessionId, (current) => ({ ...current, expanded: !current.expanded })),
    ),

  togglePaneSide: (sessionId) =>
    set((state) =>
      patch(state, sessionId, (current) => ({
        ...current,
        side: current.side === 'right' ? 'left' : 'right',
      })),
    ),

  setPaneSize: (size, sessionId) =>
    set((state) => patch(state, sessionId, (current) => ({ ...current, size }))),

  removeSession: (sessionId) =>
    set((state) => {
      const bySession = drop(state.bySession, sessionId)
      return bySession === state.bySession ? state : { bySession }
    }),
}))

useLayoutStore.subscribe((state, previous) => {
  if (state.bySession !== previous.bySession) schedulePersist(state.bySession)
})

/** Apply a patch to one session's pane slice, defaulting to the active session. */
function patch(
  state: LayoutState,
  sessionId: string | undefined,
  update: (current: SessionPanes) => SessionPanes,
): Partial<LayoutState> {
  const id = sessionId ?? useSessionsStore.getState().activeSessionId
  // No session means no right pane exists to act on (workspace home).
  if (!id) return state
  return { bySession: panes.patch(state.bySession, id, update) }
}

/**
 * Active session's pane layout. A plain `useLayoutStore` selector is not
 * enough — the answer also changes when the active session changes. The slice
 * object is stable until that session's layout changes, so returning it whole
 * is render-safe.
 */
export function useActivePanes(): SessionPanes {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  return useLayoutStore((s) => sessionPanes(s, activeSessionId))
}

/** Open a file from anywhere (chat chips, diffs, finder) into the Files pane. */
export async function openFileInWorkspace(
  workspacePath: string,
  path: string,
  line?: number,
): Promise<void> {
  const { useFilesStore } = await import('./files')
  const absolute = path.startsWith('/') ? path : `${workspacePath}/${path}`
  // Read first, switch second: a markdown link can name a path that does not
  // exist, and swapping the pane before the read means a failed open still
  // hides whatever the user was looking at.
  await useFilesStore.getState().openFile(workspacePath, absolute, line)
  useLayoutStore.getState().setRightPane('files')
}
