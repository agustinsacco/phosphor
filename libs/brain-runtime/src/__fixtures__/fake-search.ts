import type { BrainRecall } from '@phosphor/shared/brain'
import type { SearchInput } from '@phosphor/memory-engine/types'
import type { BrainSearchPort } from '../types'

export class FakeBrainSearch implements BrainSearchPort {
  searches: SearchInput[] = []
  entityNeighbours: { id: string; score: number }[][] = []
  memoryNeighbours: { id: string; score: number }[][] = []
  refreshes = 0
  closed = false
  result: BrainRecall = {
    status: 'no_match',
    hits: [],
    entities: [],
    focus: [],
    paths: [],
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
  async recent() {
    return { items: [] }
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
