import { laneArchives } from '@phosphor/host-client/lane-archive'
import { handle } from './handle'

export function registerHostArchiveHandlers(connection: Parameters<typeof laneArchives>[0]): void {
  const archive = laneArchives(connection)
  handle('hosts:archiveLane', (_event, host, lane) => archive.archive(host, lane))
  handle('hosts:archives', (_event, host, measure) => archive.list(host, measure))
  handle('hosts:restoreArchive', (_event, host, id) => archive.restore(host, id))
  handle('hosts:purgeArchive', (_event, host, id, removeWorktree) =>
    archive.purge(host, id, removeWorktree),
  )
}
