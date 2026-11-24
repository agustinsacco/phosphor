import { emptyExpansion, emptyRoutes } from '../search/query'
import type { BrainRecall } from '@phosphor/shared/brain-recall'
import type { BrainEntitySummary } from '@phosphor/shared/brain-explore'
import type { SearchInput } from '@phosphor/memory-engine/types'
import type { BrainSearchPort } from '../types'

export class FakeBrainSearch implements BrainSearchPort {
  searches: SearchInput[] = []
  entityNeighbours: { id: string; score: number }[][] = []
  memoryNeighbours: { id: string; score: number }[][] = []
  refreshes = 0
  closed = false
  result: BrainRecall = {
    mode: 'search',
    status: 'no_match',
    hits: [],
    entities: [],
    focus: [],
    branch: null,
    more: 0,
    degradation: [],
  }
  async refresh() {
    this.refreshes++
  }
  async ready() {
    return true
  }
  async recall(input: SearchInput) {
    this.searches.push(input)
    return this.result
  }
  async entities() {
    return { items: [], more: false, kinds: [], counts: {}, total: 0 }
  }
  async resolve(names: string[]): Promise<BrainEntitySummary[][]> {
    return names.map(() => [])
  }
  async expand() {
    return emptyExpansion()
  }
  async routes() {
    return emptyRoutes()
  }
  async find() {
    return { entities: [], memories: [], referenced: [], degradation: [] }
  }
  async nearestEntities(vectors: Float32Array[]) {
    return vectors.map((_v, i) => this.entityNeighbours[i] ?? [])
  }
  async nearestMemories(vectors: Float32Array[]) {
    return vectors.map((_v, i) => this.memoryNeighbours[i] ?? [])
  }
  async close() {
    this.closed = true
  }
}
