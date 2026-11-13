import { vi } from 'vitest'
import { EMBEDDING_MAX_TEXTS } from '../embedding/model-manifest'
import type { BrainServiceOptions } from '../types'
import { FakeBrainSearch, type FakeBrainStore } from './fake-store'

export function recallOptions(store: FakeBrainStore): BrainServiceOptions {
  return {
    directory: '/made-up/brain',
    openStore: () => store,
    openSearch: () => new FakeBrainSearch(),
    embeddings: {
      status: () => ({
        phase: 'ready',
        receivedBytes: 0,
        totalBytes: 0,
        modelId: 'fake',
        dimensions: 768,
      }),
      setEnabled: async () => {},
      download: async () => {},
      remove: async () => {},
      embed: vi.fn(async (texts: string[]) => {
        if (texts.length > EMBEDDING_MAX_TEXTS)
          throw new Error(`At most ${EMBEDDING_MAX_TEXTS} texts can be embedded at once`)
        return texts.map(() => [1, ...Array<number>(767).fill(0)])
      }),
      dispose() {},
    },
    lanes: {
      busy: () => false,
      launch: async () => ({ binaryPath: 'pi', prefixArgs: [], env: {} }),
    },
    guardExtension: '/guard.mjs',
    recall: { extension: '/brain.mjs', skill: '/brain/SKILL.md' },
  }
}
