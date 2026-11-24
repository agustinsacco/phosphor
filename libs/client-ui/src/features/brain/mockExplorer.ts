import type {
  BrainConnection,
  BrainConnectionGroup,
  BrainEntity,
  BrainEntityKind,
  BrainEntityPage,
  BrainEntitySummary,
  BrainEntityView,
  BrainGraph,
  BrainLink,
  BrainMemoryDetail,
  BrainMemoryFilter,
  BrainMemoryPage,
  BrainPredicate,
} from '@shared/brain'
import { BRAIN_MEMORY_TYPES, brainLinkEnded } from '@shared/brain'
import { BRAIN_ENTITY_SORTS, type BrainEntitySort } from '@shared/brain-explore'
import { mockBrainData } from './mockBrainData'

const PAGE = 20

/** The invented graph behind every explorer read: bounded pages, current and ended links. */
export class MockExplorer {
  entities: BrainEntity[]
  details: BrainMemoryDetail[]
  private merged = new Map<string, string[]>()
  private survivors = new Map<string, string>()
  constructor(readonly now: () => number = () => Date.now()) {
    const sample = mockBrainData()
    this.entities = sample.entities
    this.details = sample.details
  }
  /** Links stated by memories that are still current, current or ended. */
  private stated(): BrainLink[] {
    return this.details
      .filter(({ memory }) => memory.state !== 'superseded')
      .flatMap(({ memory }) => memory.links)
  }
  /** Links on the map now: on a current memory, not ended. */
  liveLinks(): BrainLink[] {
    return this.stated().filter((link) => !brainLinkEnded(link, this.now()))
  }
  private endedLinks(): BrainLink[] {
    return this.stated().filter((link) => brainLinkEnded(link, this.now()))
  }
  summary(entity: BrainEntity): BrainEntitySummary {
    const memories = this.details.filter(({ memory }) => memory.entityIds.includes(entity.id))
    const neighbours = new Set(
      this.liveLinks()
        .filter((l) => l.subjectId === entity.id || l.objectId === entity.id)
        .map((l) => (l.subjectId === entity.id ? l.objectId : l.subjectId)),
    )
    return { ...entity, memories: memories.length, connections: neighbours.size }
  }
  browse(
    kind: BrainEntityKind | null,
    offset: number,
    limit: number,
    sort: BrainEntitySort,
  ): BrainEntityPage {
    if (!BRAIN_ENTITY_SORTS.includes(sort)) throw new Error('Invalid Brain entity sort.')
    const all = this.entities.map((e) => this.summary(e)).filter((e) => e.memories > 0)
    const learned = (id: string): number =>
      Math.max(
        0,
        ...this.details
          .filter((d) => d.memory.entityIds.includes(id) && d.memory.state !== 'superseded')
          .map((d) => d.memory.observedAt),
      )
    const rows = all
      .filter((e) => !kind || e.kind === kind)
      .sort((a, b) =>
        sort === 'name'
          ? a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id)
          : sort === 'recent'
            ? learned(b.id) - learned(a.id)
            : b.connections - a.connections,
      )
    const counts: BrainEntityPage['counts'] = {}
    for (const e of all) counts[e.kind] = (counts[e.kind] ?? 0) + 1
    return {
      items: rows
        .slice(offset, offset + limit)
        .map((entity) => ({ entity, memories: entity.memories })),
      more: rows.length > offset + limit,
      kinds: [...new Set(all.map((e) => e.kind))],
      counts,
      total: rows.length,
    }
  }
  graph(centerId: string | null, hops: 1 | 2 = 1): BrainGraph {
    const links = this.liveLinks()
    let ids = new Set(centerId ? [centerId] : this.entities.map((e) => e.id))
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
    const ended = centerId
      ? this.endedLinks().filter((l) => l.subjectId === centerId || l.objectId === centerId)
      : []
    for (const link of ended) ids.add(link.subjectId === centerId ? link.objectId : link.subjectId)
    const nodes = this.entities
      .filter((e) => ids.has(e.id))
      .slice(0, 300)
      .map((e) => this.summary(e))
    const shown = new Set(nodes.map((e) => e.id))
    const inside = (link: BrainLink): boolean =>
      shown.has(link.subjectId) && shown.has(link.objectId)
    return {
      nodes,
      links: links.filter(inside),
      ended: ended.filter(inside),
      centerId,
      truncated: ids.size > 300,
    }
  }
  connections(
    id: string,
    predicate: BrainPredicate,
    direction: 'out' | 'in',
    cursor: string | null,
  ) {
    const offset = Number(cursor ?? 0)
    const items = this.connectionsOf(id, this.liveLinks()).filter(
      (item) =>
        item.link.predicate === predicate &&
        (direction === 'out' ? item.link.subjectId : item.link.objectId) === id,
    )
    return {
      items: items.slice(offset, offset + PAGE),
      next: offset + PAGE < items.length ? String(offset + PAGE) : null,
      total: items.length,
    }
  }
  /** One row per neighbour, predicate and direction: its newest link and how many state it. */
  private connectionsOf(id: string, links: BrainLink[]): BrainConnection[] {
    const rows = new Map<string, BrainConnection>()
    for (const link of links) {
      if (link.subjectId !== id && link.objectId !== id) continue
      const out = link.subjectId === id
      const other = out ? link.objectId : link.subjectId
      const key = `${out ? 'out' : 'in'}:${link.predicate}:${other}`
      const seen = rows.get(key)
      const entity = this.entities.find((e) => e.id === other)
      if (!entity) continue
      rows.set(key, {
        entity: seen?.entity ?? this.summary(entity),
        link: seen?.link ?? link,
        supports: (seen?.supports ?? 0) + 1,
      })
    }
    return [...rows.values()]
  }
  private resolve(id: string): string {
    const seen = new Set<string>()
    while (!this.entities.some((e) => e.id === id) && this.survivors.has(id) && !seen.has(id)) {
      seen.add(id)
      id = this.survivors.get(id)!
    }
    return id
  }
  entity(requested: string): BrainEntityView {
    const id = this.resolve(requested)
    const entity = this.entities.find((e) => e.id === id)
    if (!entity) throw new Error('Entity not found')
    const groups = new Map<string, BrainConnectionGroup>()
    for (const { link } of this.connectionsOf(id, this.liveLinks())) {
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
    const together = this.together(id)
    return {
      entity: this.summary(entity),
      groups: [...groups.values()],
      ended: this.connectionsOf(id, this.endedLinks()).slice(0, 20),
      together: together.slice(0, 12),
      togetherMore: Math.max(0, together.length - 12),
      sources: [
        ...new Map(
          memories.flatMap(({ memory }) =>
            memory.origin ? [[memory.origin.sessionId, memory.origin] as const] : [],
          ),
        ).values(),
      ].map((origin) => ({
        ...origin,
        memories: memories.filter(({ memory }) => memory.origin?.sessionId === origin.sessionId)
          .length,
      })),
      lastLearnedAt: Math.max(0, ...memories.map(({ memory }) => memory.observedAt)) || null,
      merged: this.merged.get(id) ?? [],
      memoryCounts: Object.fromEntries(
        BRAIN_MEMORY_TYPES.map((type) => [
          type,
          memories.filter(({ memory }) => memory.type === type).length,
        ]),
      ) as BrainEntityView['memoryCounts'],
    }
  }
  /** Named in the same current memories as `id`, with no link either way, most shared first. */
  together(id: string): { entity: BrainEntitySummary; shared: number }[] {
    const linked = new Set(
      this.stated().flatMap((l) =>
        l.subjectId === id ? [l.objectId] : l.objectId === id ? [l.subjectId] : [],
      ),
    )
    const shared = new Map<string, number>()
    for (const { memory } of this.details) {
      if (memory.state === 'superseded' || !memory.entityIds.includes(id)) continue
      for (const other of memory.entityIds)
        if (other !== id && !linked.has(other)) shared.set(other, (shared.get(other) ?? 0) + 1)
    }
    return [...shared]
      .flatMap(([other, count]) => {
        const entity = this.entities.find((e) => e.id === other)
        return entity ? [{ entity: this.summary(entity), shared: count }] : []
      })
      .sort((a, b) => b.shared - a.shared || a.entity.label.localeCompare(b.entity.label))
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
    if (!detail) throw new Error('Brain memory not found.')
    const named = new Set([
      ...detail.memory.entityIds,
      ...detail.memory.links.flatMap((l) => [l.subjectId, l.objectId]),
    ])
    return { ...detail, entities: this.entities.filter((e) => named.has(e.id)) }
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
  merge(source: string, target: string): void {
    const a = this.entities.find((e) => e.id === source),
      b = this.entities.find((e) => e.id === target)
    if (!a || !b || a === b) throw new Error('Choose two different entities')
    b.aliases.push(a.label, ...a.aliases)
    this.survivors.set(source, target)
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
