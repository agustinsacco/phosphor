import { create } from 'zustand'
import type {
  AgentMessage,
  ImageContent,
  Model,
  PiEvent,
  RpcSessionState,
  RpcSlashCommand,
  SessionStats,
  ThinkingLevel,
} from '@shared/rpc'
import type { OmpSubagentFrame, OmpSubagentSnapshot } from '@shared/omp-subagents'
import {
  emptyChatSession,
  hydrateFromMessages,
  newItemId,
  reduceChatEvent,
  reduceSubagentFrame,
  restoreSubagents,
  type BashItem,
  type ChatSessionState,
} from '@/features/chat/reducer'
import { drop, keyedSliceFrom } from './keyedSlice'

export interface ChatSession extends ChatSessionState {
  /** Session metadata fetched over RPC. */
  meta: RpcSessionState | null
  stats: SessionStats | null
  models: Model[]
  /**
   * False until `bootstrapSession` has heard back from `get_available_models`.
   * Without it an empty `models` is ambiguous, and the picker renders "no
   * models configured" while the answer is still in flight.
   */
  modelsLoaded: boolean
  commands: RpcSlashCommand[]
  /**
   * Levels the current model supports, straight from pi
   * (`get_available_thinking_levels`). `null` means "not asked yet" — the
   * picker then derives them locally rather than falling back to a hardcoded
   * list that is wrong for most models.
   */
  thinkingLevels: ThinkingLevel[] | null
  /**
   * True between opening a session that has history on disk and that history
   * arriving. Distinguishes "resuming, messages still replaying" from "brand
   * new session, nothing to show" — without it the chat rendered its empty
   * state over a session with ten turns of history.
   */
  resuming: boolean
}

const emptySession = (): ChatSession => ({
  ...emptyChatSession(),
  meta: null,
  stats: null,
  models: [],
  modelsLoaded: false,
  commands: [],
  thinkingLevels: null,
  resuming: false,
})

/**
 * Built from a factory, not a frozen singleton like the other keyed stores: a
 * `ChatSession` owns the item/queue arrays the reducer appends to, so every
 * session needs its own.
 */
const chats = keyedSliceFrom(emptySession)

interface ChatStore {
  sessions: Record<string, ChatSession>
  ensure: (sessionId: string, options?: { resuming?: boolean }) => void
  applyEvent: (sessionId: string, event: PiEvent) => void
  /** omp only: a forwarded subagent frame, onto its `task` call. */
  applySubagentFrame: (sessionId: string, frame: OmpSubagentFrame) => void
  /** omp only: `get_subagents` at open (see `restoreSubagents`). */
  restoreSubagents: (sessionId: string, snapshots: OmpSubagentSnapshot[]) => void
  addUserMessage: (sessionId: string, text: string, images?: ImageContent[]) => void
  /** Drop the "waiting for pi to start" state without an agent event (abort). */
  clearPromptSent: (sessionId: string) => void
  addBashItem: (sessionId: string, item: Omit<BashItem, 'id' | 'kind'>) => string
  updateBashItem: (sessionId: string, id: string, patch: Partial<BashItem>) => void
  hydrate: (sessionId: string, messages: AgentMessage[]) => void
  /** Clear the resuming flag; safe to call when it is already clear. */
  doneResuming: (sessionId: string) => void
  setError: (sessionId: string, error: string | null) => void
  setMeta: (sessionId: string, meta: RpcSessionState) => void
  patchMeta: (sessionId: string, patch: Partial<RpcSessionState>) => void
  setStats: (sessionId: string, stats: SessionStats) => void
  setModels: (sessionId: string, models: Model[]) => void
  setCommands: (sessionId: string, commands: RpcSlashCommand[]) => void
  setThinkingLevels: (sessionId: string, levels: ThinkingLevel[] | null) => void
  remove: (sessionId: string) => void
}

function patchSession(
  sessions: Record<string, ChatSession>,
  sessionId: string,
  patch: Partial<ChatSession>,
): Record<string, ChatSession> {
  return chats.patch(sessions, sessionId, (session) => ({ ...session, ...patch }))
}

export const useChatStore = create<ChatStore>((set) => ({
  sessions: {},

  ensure: (sessionId, options) =>
    set((state) =>
      state.sessions[sessionId]
        ? state
        : {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...emptySession(), resuming: options?.resuming ?? false },
            },
          },
    ),

  applyEvent: (sessionId, event) => {
    set((state) => {
      const session = chats.read(state.sessions, sessionId)
      const reduced = reduceChatEvent(session, event)
      if (reduced === session) return state
      return { sessions: { ...state.sessions, [sessionId]: { ...session, ...reduced } } }
    })
  },

  applySubagentFrame: (sessionId, frame) => {
    set((state) => {
      const session = chats.read(state.sessions, sessionId)
      const reduced = reduceSubagentFrame(session, frame)
      if (reduced === session) return state
      return { sessions: { ...state.sessions, [sessionId]: { ...session, ...reduced } } }
    })
  },

  restoreSubagents: (sessionId, snapshots) => {
    set((state) => {
      const session = chats.read(state.sessions, sessionId)
      const reduced = restoreSubagents(session, snapshots)
      if (reduced === session) return state
      return { sessions: { ...state.sessions, [sessionId]: { ...session, ...reduced } } }
    })
  },

  addUserMessage: (sessionId, text, images) =>
    set((state) => ({
      sessions: chats.patch(state.sessions, sessionId, (session) => ({
        ...session,
        items: [
          ...session.items,
          { id: newItemId(), kind: 'user', text, images, optimistic: true },
        ],
        // A prompt is on its way to pi. Cleared by the first agent event, so
        // the booting indicator covers exactly the silent window.
        promptSentAt: Date.now(),
      })),
    })),

  clearPromptSent: (sessionId) =>
    set((s) =>
      s.sessions[sessionId]?.promptSentAt == null
        ? s
        : { sessions: patchSession(s.sessions, sessionId, { promptSentAt: null }) },
    ),

  addBashItem: (sessionId, item) => {
    const id = newItemId()
    set((state) => ({
      sessions: chats.patch(state.sessions, sessionId, (session) => ({
        ...session,
        items: [...session.items, { ...item, id, kind: 'bash' }],
      })),
    }))
    return id
  },

  updateBashItem: (sessionId, id, patch) =>
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            items: session.items.map((item) =>
              item.id === id && item.kind === 'bash' ? { ...item, ...patch } : item,
            ),
          },
        },
      }
    }),

  hydrate: (sessionId, messages) =>
    set((state) => ({
      sessions: chats.patch(state.sessions, sessionId, (session) => ({
        ...session,
        ...hydrateFromMessages(messages),
        resuming: false,
      })),
    })),

  doneResuming: (sessionId) =>
    set((s) =>
      s.sessions[sessionId]?.resuming
        ? { sessions: patchSession(s.sessions, sessionId, { resuming: false }) }
        : s,
    ),

  setError: (sessionId, error) =>
    set((s) => ({
      sessions: patchSession(s.sessions, sessionId, {
        error,
        ...(error ? { resuming: false, promptSentAt: null } : {}),
      }),
    })),
  setMeta: (sessionId, meta) =>
    set((s) => ({ sessions: patchSession(s.sessions, sessionId, { meta }) })),
  patchMeta: (sessionId, patch) =>
    set((s) => {
      const session = s.sessions[sessionId]
      if (!session?.meta) return s
      return {
        sessions: patchSession(s.sessions, sessionId, { meta: { ...session.meta, ...patch } }),
      }
    }),
  setStats: (sessionId, stats) =>
    set((s) => ({ sessions: patchSession(s.sessions, sessionId, { stats }) })),
  setModels: (sessionId, models) =>
    set((s) => ({ sessions: patchSession(s.sessions, sessionId, { models, modelsLoaded: true }) })),
  setCommands: (sessionId, commands) =>
    set((s) => ({ sessions: patchSession(s.sessions, sessionId, { commands }) })),
  setThinkingLevels: (sessionId, levels) =>
    set((s) => ({ sessions: patchSession(s.sessions, sessionId, { thinkingLevels: levels }) })),

  remove: (sessionId) =>
    set((state) => {
      const sessions = drop(state.sessions, sessionId)
      return sessions === state.sessions ? state : { sessions }
    }),
}))
