import { vi } from 'vitest'
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
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
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
