import { create } from 'zustand'
import type { AgentMessage, ToolResultMessage } from '@shared/rpc'
import { drop } from './keyedSlice'
import { isArtifactWriteTool } from '@/lib/artifactTools'
import { useLayoutStore, sessionPanes } from './layout'

export type ArtifactType = 'html' | 'markdown' | 'svg' | 'mermaid' | 'code' | 'chart'

interface ArtifactVersion {
  version: number
  content: string
  title: string
  createdAt: number
}

export interface Artifact {
  id: string
  title: string
  type: ArtifactType
  language?: string
  versions: ArtifactVersion[]
  updatedAt: number
}

/**
 * The `details` payload pi-ext's artifact tools attach to their results —
 * the ONE renderer-side mirror of pi-ext/artifacts.ts's ArtifactDetails.
 * Import this everywhere the payload is read (store ingest, tool cards,
 * summaries) instead of re-declaring the shape.
 *
 * Legacy caveat, still defended here: `artifact_update` results USED TO ship
 * `type: 'update'` (a tool sentinel, not an artifact type) and default their
 * `title` to the slug id. The extension now carries the real type and title
 * forward, but sessions recorded before that fix still hold the sentinel, so
 * `normalizeArtifactType` stays and the store's metadata still wins.
 */
export interface ArtifactToolDetails {
  id?: string
  title?: string
  type?: string
  language?: string
  content?: string
  version?: number
}

interface ArtifactsState {
  /** sessionId → artifactId → artifact. */
  bySession: Record<string, Record<string, Artifact>>
  /** sessionId → selected artifact id in the viewer. */
  selected: Record<string, string | undefined>
  /** sessionId → version explicitly requested by a "open at vN" navigation. */
  selectedVersion: Record<string, number | undefined>
  /** Unseen version count while the pane is closed. */
  unseen: Record<string, number>

  ingest: (
    sessionId: string,
    toolName: string,
    details: unknown,
    opts?: { autoOpen?: boolean },
  ) => void
  ingestFromHistory: (sessionId: string, messages: AgentMessage[]) => void
  addLocal: (
    sessionId: string,
    artifact: { title: string; type: ArtifactType; language?: string; content: string },
  ) => void
  select: (sessionId: string, artifactId: string, version?: number) => void
  clearUnseen: (sessionId: string) => void
  remove: (sessionId: string) => void
}

const VALID_TYPES = new Set(['html', 'markdown', 'svg', 'mermaid', 'code', 'chart'])

/**
 * A payload `type` is only trustworthy when it names a real artifact type —
 * pre-fix `artifact_update` payloads carry the sentinel `'update'` instead.
 */
export function normalizeArtifactType(
  type: string | undefined,
  fallback: ArtifactType = 'code',
): ArtifactType {
  return VALID_TYPES.has(type ?? '') ? (type as ArtifactType) : fallback
}

export const useArtifactsStore = create<ArtifactsState>((set, get) => ({
  bySession: {},
  selected: {},
  selectedVersion: {},
  unseen: {},

  ingest: (sessionId, toolName, rawDetails, opts = {}) => {
    const details = rawDetails as ArtifactToolDetails | undefined
    if (!details?.id || typeof details.content !== 'string') return

    set((state) => {
      const session = { ...(state.bySession[sessionId] ?? {}) }
      const existing = session[details.id!]
      const version: ArtifactVersion = {
        version: details.version ?? (existing ? existing.versions.length + 1 : 1),
        content: details.content!,
        title: details.title ?? existing?.title ?? details.id!,
        createdAt: Date.now(),
      }

      if (toolName !== 'artifact_create' && existing) {
        session[details.id!] = {
          ...existing,
          title:
            details.title && details.type === 'update'
              ? existing.title
              : (details.title ?? existing.title),
          versions: [
            ...existing.versions.filter((v) => v.version !== version.version),
            version,
          ].sort((a, b) => a.version - b.version),
          updatedAt: Date.now(),
        }
      } else {
        const type = normalizeArtifactType(details.type, existing?.type ?? 'code')
        session[details.id!] = {
          id: details.id!,
          title: details.title ?? details.id!,
          type,
          language: details.language ?? existing?.language,
          versions: [
            ...(existing?.versions.filter((v) => v.version !== version.version) ?? []),
            version,
          ].sort((a, b) => a.version - b.version),
          updatedAt: Date.now(),
        }
      }

      const layout = useLayoutStore.getState()
      // Scope the check to the artifact's OWN session: a background session
      // producing artifacts must not read the foreground session's pane state
      // (that is what "is the pane open" used to mean when it was global).
      const paneOpen = sessionPanes(layout, sessionId).pane === 'artifacts'
      // First artifact in a session auto-opens the pane.
      const isFirst = Object.keys(state.bySession[sessionId] ?? {}).length === 0
      if (isFirst && opts.autoOpen !== false && !paneOpen) {
        layout.setRightPane('artifacts', sessionId)
      }

      // Don't yank the open viewer off an artifact the user is reading: an
      // incoming version only claims selection when nothing is selected, when
      // it targets the already-selected artifact, or when the pane is closed
      // (in which case selection just decides what opens later).
      const alreadySelected = state.selected[sessionId]
      const claimSelection = !paneOpen || alreadySelected == null || alreadySelected === details.id

      return {
        bySession: { ...state.bySession, [sessionId]: session },
        selected: claimSelection ? { ...state.selected, [sessionId]: details.id } : state.selected,
        unseen: paneOpen
          ? state.unseen
          : { ...state.unseen, [sessionId]: (state.unseen[sessionId] ?? 0) + 1 },
      }
    })
  },

  ingestFromHistory: (sessionId, messages) => {
    for (const message of messages) {
      if (!('role' in message) || message.role !== 'toolResult') continue
      const result = message as ToolResultMessage
      if (!isArtifactWriteTool(result.toolName)) continue
      if (result.isError) continue
      get().ingest(sessionId, result.toolName, result.details, { autoOpen: false })
    }
  },

  addLocal: (sessionId, artifact) => {
    const id = `local-${artifact.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)}-${Date.now().toString(36).slice(-4)}`
    get().ingest(sessionId, 'artifact_create', {
      id,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language,
      content: artifact.content,
      version: 1,
    })
  },

  select: (sessionId, artifactId, version) =>
    set((s) => ({
      selected: { ...s.selected, [sessionId]: artifactId },
      selectedVersion: { ...s.selectedVersion, [sessionId]: version },
    })),

  clearUnseen: (sessionId) => set((s) => ({ unseen: { ...s.unseen, [sessionId]: 0 } })),

  // All four records are keyed by sessionId; cleaning only `bySession` left
  // the selection and unseen-count entries behind for every disposed session.
  remove: (sessionId) =>
    set((s) => ({
      bySession: drop(s.bySession, sessionId),
      selected: drop(s.selected, sessionId),
      selectedVersion: drop(s.selectedVersion, sessionId),
      unseen: drop(s.unseen, sessionId),
    })),
}))

/**
 * Open one artifact in its pane, from anywhere in the UI (an `artifact://id`
 * link in chat, a tool card). Returns false when this session has no such
 * artifact — the caller decides how to say so, since a chat link can name an
 * id that never existed or was written before a fork.
 */
export function openArtifact(sessionId: string, artifactId: string, version?: number): boolean {
  const store = useArtifactsStore.getState()
  if (!store.bySession[sessionId]?.[artifactId]) return false
  store.select(sessionId, artifactId, version)
  store.clearUnseen(sessionId)
  useLayoutStore.getState().setRightPane('artifacts', sessionId)
  return true
}
