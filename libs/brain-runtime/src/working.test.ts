import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { adapterFixture } from './__fixtures__/adapter-fixture'
import { createBrainWorking } from './working'
import { createBrainBridge, type BrainCapability } from './bridge'
import { createBrainIndexer } from './indexer'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const f = await adapterFixture()
  cleanup.push(f.cleanup)
  const bridge = await createBrainBridge({
    allowed: async () => false,
    invoke: async () => undefined,
  })
  cleanup.push(() => bridge.close())
  let nativeId = 'native-recipient'
  const client = Object.assign(new EventEmitter(), {
    request: vi.fn(async (command: { type: string }) =>
      command.type === 'get_state'
        ? { success: true, data: { sessionId: nativeId } }
        : { success: true, data: { entries: [] } },
    ),
  })
  const live: LiveSession = {
    sessionId: 'working',
    workspacePath: f.scope,
    client: client as unknown as PiRpcClient,
  }
  f.lives.set(live.sessionId, live)
  const indexer = createBrainIndexer(f.store, f.embeds)
  cleanup.push(async () => indexer.dispose())
  const working = createBrainWorking(f.options, f.store, bridge, indexer)
  cleanup.push(async () => working.dispose())
  const augmentation = await working.memory.prepare({ workspacePath: f.scope })
  await augmentation!.onCreated(live)
  const capability: BrainCapability = {
    kind: 'working',
    scope: f.scope,
    policyEpoch: f.snapshot.policyEpoch,
    sessionId: live.sessionId,
  }
  return {
    ...f,
    bridge,
    working,
    capability,
    live,
    client,
    setNativeId: (id: string) => {
      nativeId = id
    },
  }
}
it('independently denies another branch on read, scope widening and omitted lane authority', async () => {
  const f = await fixture()
  const foreign = f.engine.capture({
    ...f.evidence,
    entryId: 'foreign',
    rootIds: ['foreign'],
    sessionId: 'foreign',
    branch: 'other',
  })!
  await expect(f.working.invoke(f.capability, 'read', { evidenceId: foreign.id })).rejects.toThrow(
    'branch',
  )
  await expect(
    f.working.invoke(f.capability, 'search', { query: 'Atlas', scopes: ['/other'] }),
  ).rejects.toThrow('widened')
  await expect(
    f.working.invoke({ ...f.capability, sessionId: undefined }, 'read', {
      evidenceId: f.evidence.id,
    }),
  ).rejects.toThrow('unavailable')
  await expect(
    f.working.invoke(f.capability, 'search', { query: 'Atlas', branch: 'other' }),
  ).rejects.toThrow('widened')
})
it('records native recipient copies so they cannot become independent evidence', async () => {
  const f = await fixture()
  await f.working.invoke(f.capability, 'read', { evidenceId: f.evidence.id })
  expect(
    f.engine.capture({ ...f.evidence, entryId: 'copy', sessionId: 'native-recipient' }),
  ).toBeNull()
})
it('tracks the current native recipient after an ordinary session switch', async () => {
  const f = await fixture()
  f.setNativeId('native-switched')
  await f.working.invoke(f.capability, 'read', { evidenceId: f.evidence.id })
  expect(
    f.engine.capture({ ...f.evidence, entryId: 'copy', sessionId: 'native-switched' }),
  ).toBeNull()
})
it('suppresses a read when the authoritative branch changes while disk is pending', async () => {
  const f = await fixture()
  const original = f.store.read
  vi.spyOn(f.store, 'read').mockImplementation(async (...args) => {
    const evidence = await original(...args)
    execFileSync('git', ['-C', f.scope, 'checkout', '-b', 'changed'], { stdio: 'ignore' })
    return evidence
  })
  await expect(
    f.working.invoke(f.capability, 'read', { evidenceId: f.evidence.id }),
  ).rejects.toThrow('branch')
})
it('revokes every old capability on a policy epoch change', async () => {
  const f = await fixture()
  f.engine.setPrefs({ ...f.snapshot.prefs, recall: false })
  await expect(
    f.working.invoke(f.capability, 'read', { evidenceId: f.evidence.id }),
  ).rejects.toThrow('unavailable')
})
