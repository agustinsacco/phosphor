import type {
  BrainConnectionGroup,
  BrainEntity,
  BrainEntitySummary,
  BrainEntityView,
  BrainGraph,
  BrainMemoryDetail,
  BrainMemoryFilter,
  BrainMemoryPage,
  BrainPaths,
  BrainPredicate,
} from '@shared/brain'
import { BRAIN_MEMORY_TYPES } from '@shared/brain'
import { mockBrainData } from './mockBrainData'

const PAGE = 20
export class MockExplorer {
  entities: BrainEntity[]
  details: BrainMemoryDetail[]
  private merged = new Map<string, string[]>()
  constructor() {
    const sample = mockBrainData()
    this.entities = sample.entities
    this.details = sample.details
  }
  summary(entity: BrainEntity): BrainEntitySummary {
    const memories = this.details.filter(({ memory }) => memory.entityIds.includes(entity.id))
    const connections =
      new Set(
        memories.flatMap(({ memory }) =>
          memory.links.flatMap((link) => [link.subjectId, link.objectId]),
        ),
      ).size - 1
    return { ...entity, memories: memories.length, connections: Math.max(0, connections) }
  }
  graph(centerId: string | null, hops: 1 | 2 = 1): BrainGraph {
    let ids = new Set(centerId ? [centerId] : this.entities.map((e) => e.id))
    const links = this.details
      .filter(({ memory }) => memory.state !== 'superseded')
      .flatMap(({ memory }) => memory.links)
    if (centerId)
      for (let i = 0; i < hops; i++) {
        const next = new Set(ids)
        for (const link of links)
          if (ids.has(link.subjectId) || ids.has(link.objectId)) {
            next.add(link.subjectId)
            next.add(link.objectId)
          }
        ids = next
      }
    const nodes = this.entities
      .filter((e) => ids.has(e.id))
      .slice(0, 300)
      .map((e) => this.summary(e))
    ids = new Set(nodes.map((e) => e.id))
    return {
      nodes,
      links: links.filter((link) => ids.has(link.subjectId) && ids.has(link.objectId)),
      centerId,
      truncated: this.entities.filter((e) => ids.has(e.id)).length > 300,
    }
  }
  connections(
    id: string,
    predicate: BrainPredicate,
    direction: 'out' | 'in',
    cursor: string | null,
  ) {
    const offset = Number(cursor ?? 0)
    const items = this.details
      .filter(({ memory }) => memory.state !== 'superseded')
      .flatMap(({ memory }) => memory.links)
      .filter(
        (link) =>
          link.predicate === predicate &&
          (direction === 'out' ? link.subjectId : link.objectId) === id,
      )
      .flatMap((link) => {
        const entity = this.entities.find(
          (e) => e.id === (direction === 'out' ? link.objectId : link.subjectId),
        )
        return entity ? [{ entity: this.summary(entity), link }] : []
      })
    return {
      items: items.slice(offset, offset + PAGE),
      next: offset + PAGE < items.length ? String(offset + PAGE) : null,
      total: items.length,
    }
  }
  entity(id: string): BrainEntityView {
    const entity = this.entities.find((e) => e.id === id)
    if (!entity) throw new Error('Entity not found')
    const groups = new Map<string, BrainConnectionGroup>()
    for (const link of this.graph(id, 1).links) {
      if (link.subjectId !== id && link.objectId !== id) continue
      const direction = link.subjectId === id ? 'out' : 'in'
      const key = `${direction}:${link.predicate}`
      if (!groups.has(key))
        groups.set(key, {
          predicate: link.predicate,
          direction,
          ...this.connections(id, link.predicate, direction, null),
        })
    }
    const memories = this.details.filter(({ memory }) => memory.entityIds.includes(id))
    return {
      entity: this.summary(entity),
      groups: [...groups.values()],
      sources: [
        ...new Map(
          memories.flatMap(({ memory }) =>
            memory.origin ? [[memory.origin.sessionId, memory.origin] as const] : [],
          ),
        ).values(),
      ],
      merged: this.merged.get(id) ?? [],
      memoryCounts: Object.fromEntries(
        BRAIN_MEMORY_TYPES.map((type) => [
          type,
          memories.filter(({ memory }) => memory.type === type).length,
        ]),
      ) as BrainEntityView['memoryCounts'],
    }
  }
  memories(id: string, filter: BrainMemoryFilter, cursor: string | null): BrainMemoryPage {
    const offset = Number(cursor ?? 0)
    const matches = this.details
      .map(({ memory }) => memory)
      .filter(
        (m) =>
          m.entityIds.includes(id) &&
          (filter.states ?? ['active', 'disputed']).includes(m.state) &&
          (!filter.types?.length || filter.types.includes(m.type)) &&
          (!filter.sessionId || filter.sessionId === m.origin?.sessionId),
      )
    const memories = matches.slice(offset, offset + PAGE)
    const ids = new Set(memories.flatMap((m) => m.entityIds))
    return {
      memories,
      entities: this.entities.filter((e) => ids.has(e.id)),
      next: offset + PAGE < matches.length ? String(offset + PAGE) : null,
    }
  }
  memory(id: string): BrainMemoryDetail {
    const detail = this.details.find((item) => item.memory.id === id)
    if (!detail) throw new Error('Memory not found')
    return {
      ...detail,
      entities: this.entities.filter((e) => detail.memory.entityIds.includes(e.id)),
    }
  }
  find(query: string, limit: number) {
    const folded = query.toLocaleLowerCase()
    const entities = this.entities
      .filter((e) =>
        [e.label, ...e.aliases].some((label) => label.toLocaleLowerCase().includes(folded)),
      )
      .slice(0, limit)
      .map((e) => this.summary(e))
    const memories = this.details
      .map(({ memory }) => memory)
      .filter((m) => m.summary.toLocaleLowerCase().includes(folded))
      .slice(0, limit)
    return {
      entities,
      memories,
      referenced: this.entities.filter((e) => memories.some((m) => m.entityIds.includes(e.id))),
      degradation: [],
    }
  }
  path(from: string, to: string): BrainPaths {
    const links = this.graph(null).links
    const paths: BrainPaths['paths'] = []
    const queue = [{ at: from, ids: [from], links: [] as BrainPaths['paths'][number] }]
    while (queue.length && paths.length < 3) {
      const route = queue.shift()!
      if (route.at === to && route.links.length) {
        paths.push(route.links)
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
    const ids = new Set(paths.flatMap((path) => path.flatMap((l) => [l.subjectId, l.objectId])))
    const memoryIds = new Set(paths.flatMap((path) => path.map((l) => l.memoryId)))
    return {
      paths,
      entities: this.entities.filter((e) => ids.has(e.id)),
      memories: this.details.map(({ memory }) => memory).filter((m) => memoryIds.has(m.id)),
    }
  }
  merge(source: string, target: string): void {
    const a = this.entities.find((e) => e.id === source),
      b = this.entities.find((e) => e.id === target)
    if (!a || !b || a === b) throw new Error('Choose two different entities')
    b.aliases.push(a.label, ...a.aliases)
    this.merged.set(target, [
      ...(this.merged.get(target) ?? []),
      a.label,
      ...(this.merged.get(source) ?? []),
    ])
    this.merged.delete(source)
    this.entities = this.entities.filter((e) => e !== a)
    const repoint = (id: string): string => (id === source ? target : id)
    for (const detail of this.details) {
      detail.memory.entityIds = [...new Set(detail.memory.entityIds.map(repoint))]
      detail.memory.links = detail.memory.links
        .map((link) => ({
          ...link,
          subjectId: repoint(link.subjectId),
          objectId: repoint(link.objectId),
        }))
        .filter((l) => l.subjectId !== l.objectId)
    }
  }
}
