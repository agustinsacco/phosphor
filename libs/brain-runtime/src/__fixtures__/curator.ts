import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { createCurator } from '../agent/curator'
import { recallOptions } from './options'
import { FakeAgentStore } from './fake-agent-store'
import { FakeBrainSearch } from './fake-store'

export async function curatorFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'brain-curator-'))
  const store = new FakeAgentStore()
  store.prefs.enabled = true
  const search = new FakeBrainSearch()
  let running: { runId: string; signal: AbortSignal } | null = null
  const queue = {
    kick: vi.fn(),
  }
  const changed = vi.fn()
  const options = { ...recallOptions(store), directory }
  const curator = createCurator({
    store,
    search,
    options,
    queue,
    defrag: { turnRun: () => running },
    changed,
    enabled: () => store.prefs.enabled,
  })
  return {
    store,
    search,
    queue,
    curator,
    changed,
    options,
    inRun: (runId: string) => {
      running = { runId, signal: new AbortController().signal }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
