import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import { adapterFixture } from './__fixtures__/adapter-fixture'
import { createBrainBridge } from './bridge'
import { createBrainWorking } from './working'
import { createBrainIndexer } from './indexer'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
it.each(['baseline', 'snapshot'])(
  'revokes optional augmentation on %s failure without rejecting an ordinary resume',
  async (failure) => {
    const f = await adapterFixture()
    cleanups.push(f.cleanup)
    const bridge = await createBrainBridge({
      allowed: async () => false,
      invoke: async () => undefined,
    })
    cleanups.push(() => bridge.close())
    const issue = vi.spyOn(bridge, 'issue')
    const indexer = createBrainIndexer(f.store, f.embeds)
    cleanups.push(async () => indexer.dispose())
    const working = createBrainWorking(f.options, f.store, bridge, indexer)
    cleanups.push(async () => working.dispose())
    const augmentation = await working.memory.prepare({ workspacePath: f.scope })
    const client = Object.assign(new EventEmitter(), {
      request: vi.fn(async (command: { type: string }) =>
        command.type === 'get_state'
          ? { success: true, data: { sessionId: 'ordinary' } }
          : {
              success: true,
              data: { entries: Array.from({ length: 4001 }, (_, i) => ({ id: `old-${i}` })) },
            },
      ),
    })
    const live = { sessionId: 'ordinary', workspacePath: f.scope, client } as unknown as LiveSession
    if (failure === 'snapshot')
      vi.spyOn(f.store, 'snapshot').mockRejectedValueOnce(new Error('Snapshot unavailable'))
    const grant = issue.mock.results[0]!.value
    const revoke = vi.spyOn(grant, 'revoke')
    await expect(augmentation!.onCreated(live)).resolves.toBeUndefined()
    expect(revoke).toHaveBeenCalled()
    expect(f.options.onError).toHaveBeenCalled()
    expect(client.listenerCount('event')).toBe(0)
  },
)
