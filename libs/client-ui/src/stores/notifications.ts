import { create } from 'zustand'
import type { Toast } from './extensionUi'

/**
 * The notification inbox: what a toast leaves behind once it slides away.
 *
 * Toasts are the moment; this is the record. Every notice worth coming back
 * to lands here as well as on screen, stays until it ages out or you remove
 * it, and is either new (you have not seen it yet) or seen. The top bar's
 * bell counts the new ones and opens the drawer that lists them.
 *
 * Memory only: an entry's click action is a closure over live session state,
 * which would not survive a reload.
 */
export interface Notification {
  id: number
  /** When it arrived, or when a newer notice about the same lane replaced it. */
  at: number
  /** When the user saw it. Absent while it is new. */
  seenAt?: number
  /** One entry per lane: a newer notice about the same lane replaces this one. */
  key?: string
  kind: Toast['kind']
  title?: string
  message: string
  marker?: string
  sessionId?: string
  receipt?: Toast['receipt']
  onOpen?: Toast['onOpen']
  openLabel?: string
}

export type NoticeFields = Omit<Notification, 'id' | 'at' | 'seenAt' | 'key'>

/** Seen notices go a day after they arrived. */
export const SEEN_TTL_MS = 24 * 60 * 60 * 1000
/** New ones get longer: a weekend away should not lose them. */
export const NEW_TTL_MS = 3 * SEEN_TTL_MS
/** The drawer is a short list, not an archive. */
export const MAX_NOTIFICATIONS = 50

/**
 * Worth keeping after the toast goes: anything about a lane, anything you can
 * act on, and anything that went wrong. A one-line "Copied" or "Saved" is a
 * confirmation of what you just did, not news, so it only toasts.
 */
export function keepsNotice(notice: NoticeFields): boolean {
  return (
    !!(notice.sessionId || notice.receipt || notice.onOpen) ||
    notice.kind === 'error' ||
    notice.kind === 'warning'
  )
}

function noticeKey(notice: NoticeFields): string | undefined {
  if (notice.sessionId) return `session:${notice.sessionId}`
  const receipt = notice.receipt
  return receipt?.machineId && receipt.laneId
    ? `lane:${receipt.machineId}:${receipt.laneId}`
    : undefined
}

/** Drops what has aged out, then caps the list. Returns the same array when nothing changes. */
export function pruneNotifications(items: Notification[], now: number): Notification[] {
  const kept = items.filter((item) => now - item.at < (item.seenAt ? SEEN_TTL_MS : NEW_TTL_MS))
  const capped = kept.slice(0, MAX_NOTIFICATIONS)
  return capped.length === items.length ? items : capped
}

interface NotificationsState {
  /** Newest first. */
  items: Notification[]
  /** The drawer is showing. New notices go straight into it instead of toasting. */
  open: boolean
  /** Records a notice. Returns its entry, or undefined when it is not worth keeping. */
  record: (notice: NoticeFields) => Notification | undefined
  /** Marks these entries seen, or every entry when no ids are given. */
  markSeen: (ids?: readonly number[]) => void
  markSessionSeen: (sessionId: string) => void
  remove: (id: number) => void
  clearSeen: () => void
  /** The lane closed: its notices have nothing left to open. */
  forgetSession: (sessionId: string) => void
  prune: (now?: number) => void
  setOpen: (open: boolean) => void
}

let nextId = 1

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: [],
  open: false,

  record: (notice) => {
    if (!keepsNotice(notice)) return undefined
    const key = noticeKey(notice)
    const entry: Notification = { ...notice, id: nextId++, at: Date.now(), key }
    set((s) => ({
      items: pruneNotifications(
        [entry, ...(key ? s.items.filter((item) => item.key !== key) : s.items)],
        entry.at,
      ),
    }))
    return entry
  },

  markSeen: (ids) => {
    const now = Date.now()
    const wanted = ids ? new Set(ids) : undefined
    if (!get().items.some((item) => !item.seenAt && (!wanted || wanted.has(item.id)))) return
    set((s) => ({
      items: s.items.map((item) =>
        item.seenAt || (wanted && !wanted.has(item.id)) ? item : { ...item, seenAt: now },
      ),
    }))
  },

  markSessionSeen: (sessionId) =>
    get().markSeen(
      get()
        .items.filter((item) => item.sessionId === sessionId)
        .map((item) => item.id),
    ),

  remove: (id) => set((s) => ({ items: s.items.filter((item) => item.id !== id) })),

  clearSeen: () => set((s) => ({ items: s.items.filter((item) => !item.seenAt) })),

  forgetSession: (sessionId) => {
    if (!get().items.some((item) => item.sessionId === sessionId)) return
    set((s) => ({ items: s.items.filter((item) => item.sessionId !== sessionId) }))
  },

  prune: (now = Date.now()) => {
    const items = pruneNotifications(get().items, now)
    if (items !== get().items) set({ items })
  },

  setOpen: (open) => {
    if (open === get().open) return
    // Closing is when you have seen them: while the drawer is open the new
    // ones keep their colour, so you can tell what arrived since last time.
    if (!open) get().markSeen()
    set({ open })
  },
}))

/** How many entries are new. The bell's badge. */
export function unseenCount(state: Pick<NotificationsState, 'items'>): number {
  return state.items.reduce((count, item) => count + (item.seenAt ? 0 : 1), 0)
}
