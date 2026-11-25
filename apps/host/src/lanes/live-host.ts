import type { LaneSummary } from '@phosphor/shared/host-protocol'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { createLiveLanes } from './live'
import type { LiveOptions } from './live/state'
import { createUnattachedSnapshots } from './transcript'
import { gitTracking } from './worktree'
import { createLanePrReader } from './live/lane-pr-fold'

/**
 * The Host's live lanes as `run` wires them: snapshots of stopped lanes read from
 * their transcripts, repositories that say whether git tracks them, and lane
 * summaries that carry the PRs their session files point at. Unit suites call
 * `createLiveLanes` directly and so never spawn git or fold session files.
 */
export function createHostLiveLanes(
  options: Pick<LiveOptions, 'epoch' | 'store' | 'runtime' | 'now' | 'pauseFor'> & {
    log: RuntimeLog
    sessionsRoot: string
    composerWindows?: import('./store').HostStore['composerWindows']
    contextBudget?: () => string
  },
) {
  const { log: write, sessionsRoot, composerWindows, contextBudget, ...rest } = options
  let modelWindow: (model: NonNullable<LaneSummary['model']>) => number | undefined = () =>
    undefined
  let unattached: ReturnType<typeof createUnattachedSnapshots> = () => null
  const log = (event: string, fields: Record<string, unknown>) => write('host', event, fields)
  const live = createLiveLanes({
    ...rest,
    log,
    gitTracking,
    resetOnDetach: true,
    rememberComposer: (laneId, session) => {
      try {
        composerWindows?.remember(laneId, session)
      } catch {
        log('lane.composer_window_unsaved', { laneId })
      }
    },
    lanePrs: createLanePrReader(),
    unattached: (id) => unattached(id),
  })
  unattached = createUnattachedSnapshots({
    store: rest.store,
    summary: live.summaryFor,
    cursor: live.streams.cursor,
    sessionsRoot,
    window: (laneId, model) => {
      try {
        return composerWindows?.read(laneId, model, modelWindow(model), contextBudget?.() ?? '')
      } catch {
        return undefined
      }
    },
    log,
  })
  return {
    live,
    unattached,
    bindModelWindow: (read: typeof modelWindow) => {
      modelWindow = read
    },
  }
}
