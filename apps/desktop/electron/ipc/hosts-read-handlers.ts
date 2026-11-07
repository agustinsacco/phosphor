import { machineReads } from '@phosphor/host-client/machine-reads'
import { repositoryReads } from '@phosphor/host-client/repository-reads'
import { handle } from './handle'

type ReadConnection = Parameters<typeof machineReads>[0] & Parameters<typeof repositoryReads>[0]

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
  handle('hosts:claude', (_event, hostId) => catalogues.claude(hostId))
  handle('hosts:claudeUsage', (_event, ...args) => catalogues.claudeUsage(...args))
  handle('hosts:providers', (_event, hostId) => catalogues.providers(hostId))
  handle('hosts:skills', (_event, hostId) => catalogues.skills(hostId))
  return { repositories, catalogues }
}
