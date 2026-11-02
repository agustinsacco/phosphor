import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { createLiveLanes } from './live'
import type { LiveOptions } from './live/state'
import { createUnattachedSnapshots } from './transcript'
import { gitTracking } from './worktree'

/**
 * The Host's live lanes as `run` wires them: snapshots of stopped lanes read from
 * their transcripts, and repositories that say whether git tracks them. Unit
 * suites call `createLiveLanes` directly and so never spawn git.
 */
export function createHostLiveLanes(
  options: Pick<LiveOptions, 'epoch' | 'store' | 'runtime' | 'now'> & {
    log: RuntimeLog
    sessionsRoot: string
  },
) {
  const { log: write, sessionsRoot, ...rest } = options
  let unattached: ReturnType<typeof createUnattachedSnapshots> = () => null
  const log = (event: string, fields: Record<string, unknown>) => write('host', event, fields)
  const live = createLiveLanes({
    ...rest,
    log,
    gitTracking,
    unattached: (id) => unattached(id),
  })
  unattached = createUnattachedSnapshots({
    store: rest.store,
    summary: live.summaryFor,
    cursor: live.streams.cursor,
    sessionsRoot,
    log,
  })
  return { live, unattached }
}
