import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createBrainCuratorClient } from '@phosphor/brain-client/curator-client'
import { createBrainClient } from '@phosphor/brain-client/client'
import { createNodeBrainTransport } from '@phosphor/brain-client/node-transport'
import { createBrainService } from '../service'
import { recallOptions } from '../__fixtures__/options'
import { FakeAgentStore } from '../__fixtures__/fake-agent-store'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const curator = { extension: '/made-up/brain-curator.mjs', skill: '/made-up/skills/brain-agent' }

async function setup(withCurator = true) {
  const directory = await mkdtemp(join(tmpdir(), 'brain-curator-launch-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const store = new FakeAgentStore()
  store.prefs.enabled = true
  store.counts = { groups: 0, unlinked: 0, entities: 2, repeats: 0, conflicts: 0, flags: 1 }
  const service = await createBrainService({
    ...recallOptions(store),
    directory,
    ...(withCurator ? { curator } : {}),
  })
  cleanups.push(() => service.dispose())
  return { store, service }
}

it('hands the Brain lane its own token, extension and skill; any lane keeps recall', async () => {
  const s = await setup()
  const lane = await s.service.recallLaunch()
  const brain = await s.service.curatorLaunch()
  expect(brain).toMatchObject({
    extensions: [curator.extension],
    skills: [curator.skill],
    env: { PHOSPHOR_BRAIN_ENDPOINT: lane?.env.PHOSPHOR_BRAIN_ENDPOINT },
  })
  expect(brain!.env.PHOSPHOR_BRAIN_TOKEN).not.toBe(lane!.env.PHOSPHOR_BRAIN_TOKEN)
  expect(lane?.extensions).toEqual(['/brain.mjs'])

  const client = createBrainCuratorClient(
    createNodeBrainTransport({
      endpoint: brain!.env.PHOSPHOR_BRAIN_ENDPOINT!,
      token: brain!.env.PHOSPHOR_BRAIN_TOKEN!,
    }),
  )
  const waiting = await client.call('waiting', {})
  expect(waiting.counts).toEqual(s.store.counts)
  await expect(client.call('memory', { memoryId: 'nope' })).rejects.toMatchObject({
    code: 'remote',
    message: 'No memory',
  })
  // The lane token cannot reach a curator method; the curator token cannot flag.
  const laneTransport = createNodeBrainTransport({
    endpoint: lane!.env.PHOSPHOR_BRAIN_ENDPOINT!,
    token: lane!.env.PHOSPHOR_BRAIN_TOKEN!,
  })
  await expect(laneTransport.request('waiting', {})).rejects.toMatchObject({
    message: 'Brain request unavailable',
  })
  const flagging = createBrainClient(
    createNodeBrainTransport({
      endpoint: brain!.env.PHOSPHOR_BRAIN_ENDPOINT!,
      token: brain!.env.PHOSPHOR_BRAIN_TOKEN!,
    }),
  )
  await expect(
    flagging.flag({
      memoryId: 'm',
      problem: 'wrong',
      reason: 'Tom Lee owns it now.',
      sessionId: 'brain',
      title: 'Brain Agent',
    }),
  ).rejects.toMatchObject({ message: 'Brain request unavailable' })
})

it('needs Brain on but not lane recall, and a configured extension', async () => {
  const s = await setup()
  s.store.prefs.recall = false
  expect(await s.service.recallLaunch()).toBeUndefined()
  expect(await s.service.curatorLaunch()).toMatchObject({ extensions: [curator.extension] })
  s.store.prefs.enabled = false
  expect(await s.service.curatorLaunch()).toBeUndefined()
  const bare = await setup(false)
  expect(await bare.service.curatorLaunch()).toBeUndefined()
})
