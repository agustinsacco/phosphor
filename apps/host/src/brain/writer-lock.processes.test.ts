import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import {
  bundleFixture,
  startLineProcess,
  stopAll,
  type LineProcess,
} from './__fixtures__/line-process'

// Two Host processes with different configs (so different identity run locks) on one state
// folder: each builds its own `createHostBrain`, so only a cross-process writer lock keeps a
// second one from opening, recovering or writing the same `<state>/brain`.

let bundle: string
let stateDirectory: string

beforeAll(async () => {
  bundle = await bundleFixture(join(import.meta.dirname, '__fixtures__/brain-writer-process.ts'))
}, 60_000)
beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'host-brain-writer-'))
})
afterEach(async () => {
  stopAll()
  await rm(stateDirectory, { recursive: true, force: true })
})
afterAll(stopAll)

const startBrain = (config: string): LineProcess =>
  startLineProcess(bundle, [stateDirectory, config])

it('never creates a Brain while a fresh Host only reads its status', async () => {
  const reader = startBrain('config-a')
  expect(await reader.send('status')).toMatchObject({ state: 'off', service: false, exists: false })
  expect(existsSync(join(stateDirectory, 'brain'))).toBe(false)
})

it('admits one Brain writer across Host processes, releases a killed one and refuses a restart', async () => {
  const first = startBrain('config-a')
  const second = startBrain('config-b')
  expect(await first.send('enable')).toMatchObject({ enabled: true, state: 'ready' })

  expect(await second.send('enable')).toMatchObject({
    refused: 'Brain is open elsewhere on this Host.',
    state: 'refused',
  })
  expect(await second.send('status')).toMatchObject({ state: 'refused', service: false })

  // A writer killed without cleanup leaves its lock behind; the next writer reclaims it.
  await first.kill()
  expect(await second.send('enable')).toMatchObject({ enabled: true, state: 'ready' })

  // A restarted Host process is a second writer now, so it is refused until the holder disposes.
  const restarted = startBrain('config-a')
  expect(await restarted.send('status')).toMatchObject({ state: 'refused', service: false })
  expect(await restarted.send('enable')).toMatchObject({ state: 'refused' })
  expect(await second.send('dispose')).toMatchObject({ disposed: true })
  expect(await restarted.send('enable')).toMatchObject({ enabled: true, state: 'ready' })
}, 60_000)
