import { createHash } from 'node:crypto'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { WINDOW, windowProbes, windowsFixture } from './__fixtures__/memory-windows'

setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void
const MIB = 2 ** 20
/** Each test builds a store of 12,800 memories with vectors; a busy machine needs the room. */
const BUILD = { timeout: 60_000 }

it(
  'characterization: ranks entity, link and replaced matches exactly as before the window bound',
  BUILD,
  () => {
    const { store } = windowsFixture(100)
    try {
      const result = store.memoryMatches(windowProbes(100, 60), 5)
      const channels: Record<string, number> = {}
      for (const match of result.flat())
        channels[match.channel] = (channels[match.channel] ?? 0) + 1
      expect(channels).toEqual({ entity: 300, link: 10, replaced: 8 })
      expect(result[1]!.slice(0, 2)).toEqual([
        { id: 'memory-807', channel: 'entity', similarity: 0.0905449116630476 },
        { id: 'memory-8807', channel: 'entity', similarity: 0.08996814810228204 },
      ])
      // Recorded on the code before the bound, then again on the same code when the benchmark
      // fixture gained people and person links: every id, channel, similarity and order.
      expect(createHash('sha256').update(JSON.stringify(result)).digest('hex')).toBe(
        'd9f5d580466ad81f058286cfe4165f8d7d7840ca5e40339e4ee4264ca70b43d2',
      )
    } finally {
      store.close()
    }
  },
)

it('regression: holds at most one entity window of memory vectors at a time', BUILD, () => {
  // Before each window loads, collect garbage and sample what is still held. The second
  // collection finishes freeing the array buffers the first one found unreachable.
  const held: number[] = []
  const { store } = windowsFixture(100, () => {
    gc()
    gc()
    const usage = process.memoryUsage()
    held.push(usage.heapUsed + usage.arrayBuffers)
  })
  try {
    const probes = Array.from({ length: 100 }, (_, i) => ({
      entityIds: [`entity-${i + 1}`],
      links: [],
      vector: new Float32Array(768).fill(1),
    }))
    store.memoryMatches(probes, 5)
    expect(held).toHaveLength(100)
    // 100 windows of 128 vectors (3 KiB each) would hold about 37.5 MiB by the last one.
    expect(WINDOW * 3 * 1024 * 100).toBeGreaterThan(32 * MIB)
    expect((Math.max(...held) - held[0]!) / MIB).toBeLessThan(8)
  } finally {
    store.close()
  }
})
