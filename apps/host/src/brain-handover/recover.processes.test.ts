import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { HOST_BRAIN_WRITER_LOCK } from '../brain/writer-lock'
import { bundleFixture, startLineProcess, stopAll } from '../brain/__fixtures__/line-process'
import { ACTIVE, BEGIN, handoverWorld, stageBrain } from './__fixtures__/staged-brain'
import { handoverPaths, readHandover } from './layout'
import { publishSealed } from './publish'
import { recoverBrainHandover } from './recover'

// Two Host processes with different configs start on one state folder after a move was
// published and the Host stopped before its record. Only one may roll the move forward.

let bundle: string
const worlds: ReturnType<typeof handoverWorld>[] = []

beforeAll(async () => {
  bundle = await bundleFixture(join(import.meta.dirname, '__fixtures__/recovery-process.ts'))
}, 60_000)
afterEach(() => {
  stopAll()
  for (const world of worlds.splice(0)) world.dispose()
})
afterAll(stopAll)

async function publishedThenStopped() {
  const world = handoverWorld()
  worlds.push(world)
  const host = world.restart()
  const id = world.migrationId()
  const { staging } = await host['owner.brainHandover.begin']({ migrationId: id, ...BEGIN })
  const files = stageBrain(staging)
  await host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: ACTIVE })
  const record = readHandover(world.stateDir, id)!
  await publishSealed(world.stateDir, record)
  writeFileSync(handoverPaths(world.stateDir, id).record, JSON.stringify(record))
  return { world, id }
}

function localRecovery(world: ReturnType<typeof handoverWorld>) {
  const events: [string, Record<string, unknown> | undefined][] = []
  const imported: string[] = []
  return {
    events,
    imported,
    run: () =>
      recoverBrainHandover({
        stateDir: world.stateDir,
        importAgentTranscripts: async (input) => {
          imported.push(input.migrationId)
          return { bound: input.transcripts[0]?.sessionId ?? null }
        },
        log: (event, fields) => events.push([event, fields]),
      }),
  }
}

it('a second Host process defers its recovery while the first rolls the move forward', async () => {
  const { world, id } = await publishedThenStopped()
  const first = startLineProcess(bundle, [world.stateDir])
  expect(await first.send('recover')).toEqual({ importing: id })

  const second = localRecovery(world)
  await second.run()
  expect(second.imported).toEqual([])
  expect(second.events).toEqual([['brain.handover.recovery-held', { reason: 'writer-busy' }]])
  expect(readHandover(world.stateDir, id)?.state).not.toBe('committed')

  first.child.stdin.write('continue\n')
  expect(await first.next()).toEqual({
    events: [['brain.handover.committed', { migrationId: id, recovered: true }]],
  })
  expect(readHandover(world.stateDir, id)?.state).toBe('committed')
  expect(existsSync(join(world.stateDir, HOST_BRAIN_WRITER_LOCK))).toBe(false)
}, 60_000)

it('a Host process killed inside its roll-forward leaves a lock the next start reclaims', async () => {
  const { world, id } = await publishedThenStopped()
  const first = startLineProcess(bundle, [world.stateDir])
  expect(await first.send('recover')).toEqual({ importing: id })
  await first.kill()

  const next = localRecovery(world)
  await next.run()
  expect(next.imported).toEqual([id])
  expect(readHandover(world.stateDir, id)?.state).toBe('committed')
  expect(existsSync(join(world.stateDir, HOST_BRAIN_WRITER_LOCK))).toBe(false)
}, 60_000)
