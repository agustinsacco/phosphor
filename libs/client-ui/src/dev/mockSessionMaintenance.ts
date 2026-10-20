import type { SessionMeta } from '@shared/models'

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
  if (channel === 'sessions:delete') {
    const index = sessions.findIndex((entry) => entry.path === args[0])
    if (index !== -1) sessions.splice(index, 1)
    return Promise.resolve(args[1] ? [args[1]] : [])
  }
  return Promise.resolve(channel === 'sessions:retainedWorkspaces' ? [] : undefined)
}
