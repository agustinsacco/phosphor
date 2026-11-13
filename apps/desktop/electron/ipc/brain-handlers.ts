import type { BrainApi, BrainService } from '@phosphor/brain-runtime/types'
import { handle } from './handle'
import {
  checkDecision,
  checkFilter,
  checkLane,
  checkPrefs,
  cursorOf,
  directionOf,
  hopsOf,
  id,
  limitOf,
  predicateOf,
  revisionOf,
  text,
} from './brain-checks'

export { checkDecision, checkLane, checkPrefs } from './brain-checks'

/** Desktop-only. Lazy acquisition keeps a failed startup retryable. */
export function registerBrainHandlers(service: () => Promise<BrainService>): void {
  const api = async (): Promise<BrainApi> => (await service()).api
  handle('brain:status', async () => (await api()).status())
  handle('brain:setPrefs', async (_event, prefs) => (await api()).setPrefs(checkPrefs(prefs)))
  handle('brain:download', async () => (await api()).download())
  handle('brain:removeModel', async () => (await api()).removeModel())
  handle('brain:queue', async (_event, lane) => (await api()).queue(checkLane(lane)))
  handle('brain:cancel', async (_event, job) => (await api()).cancel(id(job)))
  handle('brain:retry', async (_event, job) => (await api()).retry(id(job)))
  handle('brain:extraction', async (_event, job) => (await api()).extraction(id(job)))
  handle('brain:proposal', async (_event, job) => (await api()).proposal(id(job)))
  handle('brain:review', async (_event, job, decision, revision) =>
    (await api()).review(id(job), checkDecision(decision), revisionOf(revision)),
  )
  handle('brain:reset', async () => (await api()).reset())
  handle('brain:merge', async (_event, source, target) => {
    const from = id(source)
    const to = id(target)
    if (from === to) throw new Error('Choose a different entity to merge into.')
    return (await api()).merge(from, to)
  })
  handle('brain:find', async (_event, query, limit) =>
    (await api()).find(text(query, 500), limitOf(limit)),
  )
  handle('brain:overview', async () => (await api()).overview())
  handle('brain:neighbourhood', async (_event, entity, hops) =>
    (await api()).neighbourhood(id(entity), hopsOf(hops)),
  )
  handle('brain:entity', async (_event, entity) => (await api()).entity(id(entity)))
  handle('brain:connections', async (_event, entity, predicate, direction, cursor) =>
    (await api()).connections(
      id(entity),
      predicateOf(predicate),
      directionOf(direction),
      cursorOf(cursor),
    ),
  )
  handle('brain:entityMemories', async (_event, entity, filter, cursor) =>
    (await api()).entityMemories(id(entity), checkFilter(filter), cursorOf(cursor)),
  )
  handle('brain:memory', async (_event, memory) => (await api()).memory(id(memory)))
  handle('brain:path', async (_event, from, to) => (await api()).path(id(from), id(to)))
  handle('brain:forget', async (_event, memory) => (await api()).forget(id(memory)))
}
