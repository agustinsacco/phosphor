import type { BrainEntity, BrainLink, BrainMemory } from '@shared/brain'
import type { BrainHit, BrainRecall, BrainRouteStep, BrainRoutes } from '@shared/brain-recall'
import type { MockExplorer } from './mockExplorer'

const ASK_LIMIT = 8
const words = (text: string): string[] =>
  text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)

/** Entities a question names: a label, another name, or a first name on its own. */
function named(explorer: MockExplorer, question: string): string[] {
  const folded = question.toLocaleLowerCase()
  const tokens = new Set(words(question))
  return explorer.entities
    .filter(
      (e) =>
        [e.label, ...e.aliases].some((name) => folded.includes(name.toLocaleLowerCase())) ||
        tokens.has(e.label.split(' ')[0]!.toLocaleLowerCase()),
    )
    .map((e) => e.id)
}

/** Shortest relation paths from the seeds over links on the map, at most `depth` hops. */
function walk(links: BrainLink[], seeds: string[], depth: number): Map<string, BrainLink[]> {
  const paths = new Map(seeds.map((id) => [id, [] as BrainLink[]]))
  let frontier = seeds
  for (let step = 0; step < depth; step++) {
    const next: string[] = []
    for (const at of frontier)
      for (const link of links) {
        const other =
          link.subjectId === at ? link.objectId : link.objectId === at ? link.subjectId : null
        if (other && !paths.has(other)) {
          paths.set(other, [...paths.get(at)!, link])
          next.push(other)
        }
      }
    frontier = next
  }
  return paths
}

/** `brain:ask`: word matches and the graph walk from what the question names, with trails. */
export function mockAsk(explorer: MockExplorer, question: string): BrainRecall {
  const focus = named(explorer, question)
  const tokens = new Set(words(question))
  const paths = walk(explorer.liveLinks(), focus, 2)
  const seedOf = (path: BrainLink[], end: string): string => {
    let at = end
    for (const link of path.toReversed())
      at = link.subjectId === at ? link.objectId : link.subjectId
    return at
  }
  const hits: BrainHit[] = explorer.details
    .map(({ memory }) => memory)
    .filter((memory) => memory.state !== 'superseded')
    .flatMap((memory): BrainHit[] => {
      const overlap = words(memory.summary).filter((word) => tokens.has(word)).length
      const reached = memory.entityIds
        .filter((id) => paths.has(id))
        .sort((a, b) => paths.get(a)!.length - paths.get(b)!.length)[0]
      if (!overlap && reached === undefined) return []
      const path = reached === undefined ? null : paths.get(reached)!
      const reasons: BrainHit['reasons'] = []
      if (overlap) reasons.push('lexical')
      if (path?.length) reasons.push('linked')
      if (path && !path.length) reasons.push('exact')
      return [
        {
          memory,
          score: overlap + (path ? 2 / (1 + path.length) : 0) + memory.importance * 0.1,
          reasons,
          trail: path ? { seedId: seedOf(path, reached!), links: path, entityId: reached! } : null,
        },
      ]
    })
    .sort((a, b) => b.score - a.score)
  const shown = hits.slice(0, ASK_LIMIT)
  return {
    mode: 'search',
    status: shown.length ? 'ok' : 'no_match',
    hits: shown,
    entities: referenced(explorer, [
      ...focus,
      ...shown.flatMap((hit) => [
        ...hit.memory.entityIds,
        ...(hit.trail?.links.flatMap((l) => [l.subjectId, l.objectId]) ?? []),
      ]),
    ]),
    focus,
    more: Math.max(0, hits.length - ASK_LIMIT),
    branch: null,
    degradation: [],
  }
}

function referenced(explorer: MockExplorer, ids: string[]): BrainEntity[] {
  const wanted = new Set(ids)
  return explorer.entities.filter((e) => wanted.has(e.id))
}

/** `brain:path`: up to three routes of at most four relation steps, else a shared memory. */
export function mockRoutes(explorer: MockExplorer, from: string, to: string): BrainRoutes {
  const links = explorer.liveLinks()
  const routes: BrainLink[][] = []
  const queue = [{ at: from, ids: [from], links: [] as BrainLink[] }]
  while (queue.length && routes.length < 3) {
    const route = queue.shift()!
    if (route.at === to && route.links.length) {
      routes.push(route.links)
      continue
    }
    if (route.links.length >= 4) continue
    for (const link of links) {
      const next =
        link.subjectId === route.at
          ? link.objectId
          : link.objectId === route.at
            ? link.subjectId
            : null
      if (next && !route.ids.includes(next))
        queue.push({ at: next, ids: [...route.ids, next], links: [...route.links, link] })
    }
  }
  const steps: BrainRouteStep[][] = routes.map((route) =>
    route.map((link) => ({ kind: 'relation', link })),
  )
  const shared = explorer.details
    .map(({ memory }) => memory)
    .filter(
      (m) => m.state !== 'superseded' && m.entityIds.includes(from) && m.entityIds.includes(to),
    )
  if (!steps.length && shared[0])
    steps.push([
      { kind: 'together', fromId: from, toId: to, memoryId: shared[0].id, shared: shared.length },
    ])
  const memoryIds = new Set(
    steps.flat().map((step) => (step.kind === 'relation' ? step.link.memoryId : step.memoryId)),
  )
  const memories: BrainMemory[] = explorer.details
    .map(({ memory }) => memory)
    .filter((m) => memoryIds.has(m.id))
  const ends = referenced(explorer, [from, to])
  return {
    mode: 'route',
    status: steps.length ? 'ok' : 'no_match',
    from: ends.find((e) => e.id === from) ?? null,
    to: ends.find((e) => e.id === to) ?? null,
    routes: steps,
    memories,
    entities: referenced(explorer, [
      from,
      to,
      ...routes.flat().flatMap((l) => [l.subjectId, l.objectId]),
    ]),
  }
}
