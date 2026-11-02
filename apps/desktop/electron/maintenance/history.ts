import Store from 'electron-store'
import type { SessionMeta } from '@shared/models'
import { sessionPathKey } from '../pi/session-path-lock'
import { createKeyedLock } from '@phosphor/session-runtime/pi/session-path-lock'

export interface RemovalRecord {
  id: string
  repoPath: string
  path: string
  branch: string
  tip: string
  recoveryRef: string
  sessions: Array<{ id: string; path: string; completedAt: number; activityAt: number }>
  reason: 'explicitly-completed-and-merged' | 'manual-confirmation'
  attemptedAt: number
  outcome: 'pending' | 'removed' | 'kept' | 'error'
  restoredAt?: number
  detail?: string
}
interface History {
  sessions: Record<string, { completedAt?: number; activityAt: number }>
  removals: RemovalRecord[]
}
let store: Store<History> | undefined
// Lazy for the same userData isolation requirement as prefs/backend.ts.
export function history(): Store<History> {
  return (store ??= new Store<History>({
    name: 'session-maintenance',
    defaults: { sessions: {}, removals: [] },
  }))
}
export function sessionDecision(path: string): { completedAt?: number; activityAt: number } {
  return history().get('sessions')[sessionPathKey(path)] ?? { activityAt: 0 }
}
export function decideSession(path: string, completed: boolean, now = Date.now()): void {
  const sessions = history().get('sessions')
  sessions[sessionPathKey(path)] = {
    ...(completed ? { completedAt: now } : {}),
    activityAt: now,
  }
  history().set('sessions', sessions)
}
export function decorateSession(meta: SessionMeta, removed: boolean): SessionMeta {
  return { ...meta, completedAt: sessionDecision(meta.path).completedAt, worktreeRemoved: removed }
}
export function saveRemoval(record: RemovalRecord): void {
  const records = history().get('removals')
  const index = records.findIndex((entry) => entry.id === record.id)
  if (index < 0) records.push(record)
  else records[index] = record
  history().set('removals', records)
}

const operations = createKeyedLock()
const intents = new Map<string, number>()
export const workspaceGeneration = (path: string): number => intents.get(sessionPathKey(path)) ?? 0
export function recordWorkspaceIntent(path: string): void {
  intents.set(sessionPathKey(path), workspaceGeneration(path) + 1)
}
/** Serializes Desktop admission, completion, restore and checkout removal. */
export async function withWorkspace<T>(path: string, run: () => Promise<T>): Promise<T> {
  return operations.run(sessionPathKey(path), run)
}
