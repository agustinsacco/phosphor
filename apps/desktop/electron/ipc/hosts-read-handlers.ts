import { machineReads } from '@phosphor/host-client/machine-reads'
import { repositoryReads } from '@phosphor/host-client/repository-reads'
import { prStatusReads, routePrStatus } from '@phosphor/host-client/pr-status-reads'
import { handle } from './handle'

type ReadConnection = Parameters<typeof machineReads>[0] &
  Parameters<typeof repositoryReads>[0] &
  Parameters<typeof prStatusReads>[0]

/**
 * GitHub reads that name a Host: a repository's PRs by branch (`gh:prsForRepo`
 * with a `host:` key) and PRs by number (`gh:prSummaries` / `gh:prDetail` with
 * a `host:` machine). Null for This Mac's.
 */
function hostGithubRouter(
  connection: ReadConnection,
  repositories: ReturnType<typeof repositoryReads>,
) {
  const prStatus = prStatusReads(connection)
  return (channel: string, args: readonly unknown[]): { result: Promise<unknown> } | null => {
    const key = args[0]
    if (channel === 'gh:prsForRepo' && typeof key === 'string' && key.startsWith('host:'))
      return { result: repositories.pullRequests(key, args[1]) }
    return routePrStatus(prStatus, channel, args)
  }
}

/** Read-only Host catalogues and repository files, answered over the manager's connection. */
export function registerHostReadHandlers(connection: ReadConnection) {
  const repositories = repositoryReads(connection)
  handle('hosts:repositoryFiles', (_event, hostId, repositoryId) =>
    repositories.list(hostId, repositoryId),
  )
  handle('hosts:repositoryFile', (_event, hostId, repositoryId, path) =>
    repositories.read(hostId, repositoryId, path),
  )
  const catalogues = machineReads(connection)
  handle('hosts:models', (_event, hostId) => catalogues.models(hostId))
  handle('hosts:commands', (_event, hostId, repositoryId) =>
    catalogues.commands(hostId, repositoryId),
  )
  handle('hosts:claude', (_event, hostId) => catalogues.claude(hostId))
  handle('hosts:claudeUsage', (_event, ...args) => catalogues.claudeUsage(...args))
  handle('hosts:providers', (_event, hostId) => catalogues.providers(hostId))
  handle('hosts:skills', (_event, hostId) => catalogues.skills(hostId))
  return { github: hostGithubRouter(connection, repositories), catalogues }
}
