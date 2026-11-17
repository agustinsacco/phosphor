import { expect, it } from 'vitest'
import { fixture, vector } from '../test-support'
import { encodeVector } from '../vectors'
import { seed } from './test-support'

function memoryPair(similarity: number, shared = true) {
  const result = fixture()
  seed(result.db, 2)
  if (shared) result.db.exec('UPDATE mentions SET entity=1')
  const update = result.db.prepare('UPDATE memory_vectors SET vector=? WHERE memory=?')
  update.run(encodeVector(vector(1, 0)), 1)
  update.run(encodeVector(vector(similarity, Math.sqrt(1 - similarity ** 2))), 2)
  return result
}

it.each([0.86, 0.83, 0.8])(
  'calibrates near-repeat candidates at cosine %s without applying them',
  (similarity) => {
    const { store } = memoryPair(similarity)
    const result = store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
    expect(store.tidy('same_memory', null, 20).items).toHaveLength(similarity >= 0.84 ? 1 : 0)
    expect(result.folded).toBe(0)
    expect(store.snapshot().counts.memories).toBe(2)
  },
)
