import {
  BRAIN_ASK_MAX,
  BRAIN_TELL_MAX,
  setBrainLaneNeverRead,
  DEFAULT_BRAIN_PREFS,
} from '@phosphor/shared/brain'
import type { BrainApi, BrainService } from '@phosphor/brain-runtime/types'
import { handle } from './handle'
import {
  checkFilter,
  checkSplit,
  checkLane,
  checkPrefs,
  cursorOf,
  descriptionOf,
  hopsOf,
  id,
  limitOf,
  revisionOf,
  text,
  messageOf,
} from './brain-checks'

export { checkLane, checkPrefs } from './brain-checks'

/** Desktop-only. Lazy acquisition keeps a failed startup retryable. */
export function registerBrainHandlers(service: () => Promise<BrainService>): void {
  const api = async (): Promise<BrainApi> => (await service()).api
  registerTidyHandlers(api)
  handle('brain:ask', async (_event, question) =>
    (await api()).ask(messageOf(question, BRAIN_ASK_MAX)),
  )
  handle('brain:tell', async (_event, message) =>
    (await api()).tell(messageOf(message, BRAIN_TELL_MAX)),
  )
  handle('brain:laneRead', async (_event, lane) => (await api()).laneRead(id(lane)))
  handle('brain:setOwner', async (_event, entity) =>
    (await api()).setOwner(entity === null ? null : id(entity)),
  )
  handle('brain:reread', async (_event, job) => (await api()).reread(id(job)))
  handle('brain:status', async () => (await api()).status())
  handle('brain:neverRead', async (_event, sessionId, never) => {
    setBrainLaneNeverRead(DEFAULT_BRAIN_PREFS, sessionId, never)
    return (await api()).neverRead(sessionId, never)
  })
  handle('brain:setPrefs', async (_event, prefs) => (await api()).setPrefs(checkPrefs(prefs)))
  handle('brain:download', async () => (await api()).download())
  handle('brain:removeModel', async () => (await api()).removeModel())
  handle('brain:queue', async (_event, lane) => (await api()).queue(checkLane(lane)))
  handle('brain:cancel', async (_event, job) => (await api()).cancel(id(job)))
  handle('brain:retry', async (_event, job) => (await api()).retry(id(job)))
  handle('brain:extraction', async (_event, job) => (await api()).extraction(id(job)))
  handle('brain:reset', async () => (await api()).reset())
  handle('brain:merge', async (_event, source, target, revision) => {
    const from = id(source)
    const to = id(target)
    if (from === to) throw new Error('Choose a different entity to merge into.')
    return (await api()).merge(from, to, revisionOf(revision))
  })
  handle('brain:describe', async (_event, entity, description, revision) =>
    (await api()).describe(id(entity), descriptionOf(description), revisionOf(revision)),
  )
  handle('brain:removeName', async (_event, entity, name, revision) =>
    (await api()).removeName(id(entity), id(name), revisionOf(revision)),
  )
  handle('brain:split', async (_event, entity, memoryIds, target, revision) => {
    const split = checkSplit(memoryIds, target)
    return (await api()).split(id(entity), split.memoryIds, split.target, revisionOf(revision))
  })
  handle('brain:find', async (_event, query, limit) =>
    (await api()).find(text(query, 500), limitOf(limit)),
  )
  handle('brain:overview', async () => (await api()).overview())
  handle('brain:neighbourhood', async (_event, entity, hops) =>
    (await api()).neighbourhood(id(entity), hopsOf(hops)),
  )
  handle('brain:entity', async (_event, entity) => (await api()).entity(id(entity)))
  handle('brain:entityMemories', async (_event, entity, filter, cursor) =>
    (await api()).entityMemories(id(entity), checkFilter(filter), cursorOf(cursor)),
  )
  handle('brain:memory', async (_event, memory) => (await api()).memory(id(memory)))
  handle('brain:path', async (_event, from, to) => (await api()).path(id(from), id(to)))
  handle('brain:forget', async (_event, memory) => (await api()).forget(id(memory)))
}

function registerTidyHandlers(api: () => Promise<BrainApi>): void {
  handle('brain:tidyChanges', async (_event, limit) => (await api()).tidyChanges(limitOf(limit)))
  handle('brain:tidyUndo', async (_event, value, revision) =>
    (await api()).tidyUndo(id(value), revisionOf(revision)),
  )
  handle('brain:defrag', async () => (await api()).defrag())
  handle('brain:defragStop', async () => (await api()).defragStop())
  handle('brain:undoRun', async (_event, run) => (await api()).undoRun(id(run)))
}
