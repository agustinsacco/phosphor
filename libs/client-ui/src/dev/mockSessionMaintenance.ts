import type { SessionMeta } from '@shared/models'
import { createMockArchive } from './mockArchive'
const archives = createMockArchive<SessionMeta>((meta) => ({
  title: meta.name || meta.firstUserText || 'Untitled lane',
  cwd: meta.cwd,
}))

export const SESSION_MAINTENANCE_MOCK: ReadonlySet<string> = new Set([
  'sessions:setCompleted',
  'sessions:retainedWorkspaces',
  'sessions:restoreWorktree',
  'sessions:worktreeRecovery',
  'sessions:recreateWorktree',
  'sessions:list',
  'sessions:delete',
  'sessions:archive',
  'sessions:archives',
  'sessions:restoreArchive',
  'sessions:purgeArchive',
])
/** Browser harness projection of Desktop's explicit completion decision. */
export function mockSessionMaintenance(
  channel: string,
  args: unknown[],
  sessions: SessionMeta[],
): Promise<unknown> {
  if (channel === 'sessions:setCompleted') {
    const session = sessions.find((entry) => entry.path === args[0])
    if (session) session.completedAt = args[1] ? Date.now() : undefined
  }
  if (channel === 'sessions:list')
    return Promise.resolve(sessions.filter((entry) => entry.cwd === args[0]))
  if (channel === 'sessions:archives') return Promise.resolve(archives.list())
  if (channel === 'sessions:archive') {
    const index = sessions.findIndex((entry) => entry.path === args[1])
    if (index === -1)
      return Promise.reject(
        new Error('Save a conversation before archiving in the browser harness.'),
      )
    archives.add(sessions[index]!)
    sessions.splice(index, 1)
    return Promise.resolve(args[2] ? [args[2]] : [])
  }
  if (channel === 'sessions:restoreArchive' || channel === 'sessions:purgeArchive') {
    const meta = archives.remove(args[0])
    if (channel === 'sessions:purgeArchive') return Promise.resolve(undefined)
    sessions.push(meta)
    return Promise.resolve({ cwd: meta.cwd, path: meta.path })
  }
  if (channel === 'sessions:delete') {
    const index = sessions.findIndex((entry) => entry.path === args[0])
    if (index !== -1) sessions.splice(index, 1)
    return Promise.resolve(args[1] ? [args[1]] : [])
  }
  if (channel === 'sessions:worktreeRecovery')
    return Promise.resolve({
      editedFiles: [],
      editedFileCount: 0,
      fresh: { base: 'origin/main', branch: 'phosphor/mock-lane' },
    })
  return Promise.resolve(channel === 'sessions:retainedWorkspaces' ? [] : undefined)
}
