import { create } from 'zustand'

export type RemoteSaveResult =
  { revision: string | undefined } | { error: string; uncertain: boolean } | null

export interface RemoteFileDraft {
  selected: string
  content: string
  before: string
  revision: string | null
  dirty: true
  uncertain: boolean
  error: string | null
  pending?: { token: symbol; result: Promise<RemoteSaveResult> }
}

/** Renderer memory only: drafts belong to a lane, never to a shared repository path. */
export const useRemoteFileDrafts = create<{
  bySession: Record<string, RemoteFileDraft>
}>(() => ({ bySession: {} }))

export function keepRemoteFileDraft(sessionId: string, draft: RemoteFileDraft): void {
  useRemoteFileDrafts.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: draft } }))
}

export function clearRemoteFileDraft(sessionId: string): void {
  useRemoteFileDrafts.setState((s) => {
    const bySession = { ...s.bySession }
    delete bySession[sessionId]
    return { bySession }
  })
}
