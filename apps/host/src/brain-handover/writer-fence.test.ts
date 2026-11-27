import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ownerLockPorts } from '@phosphor/session-runtime/owner-lock/owner-lock'
import { HOST_BRAIN_WRITER_LOCK, hostBrainWriter } from '../brain/writer-lock'
import { ACTIVE, BEGIN, handoverWorld, stageBrain } from './__fixtures__/staged-brain'
import { handoverPaths, readHandover, writeRecord } from './layout'
import { publishSealed } from './publish'
import { recoverBrainHandover } from './recover'

// Host processes with different configs share one state folder. The Brain's writer lock
// (`<state>/brain-writer.lock`) is the one fence they share, so every handover mutation and the
// startup recovery run only while this process holds it.

const worlds: ReturnType<typeof handoverWorld>[] = []
afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose()
})

async function verified() {
  const world = handoverWorld()
  worlds.push(world)
  const host = world.restart()
  const id = world.migrationId()
  const { staging } = await host['owner.brainHandover.begin']({ migrationId: id, ...BEGIN })
  const files = stageBrain(staging)
  await host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: ACTIVE })
  return { world, host, id, paths: handoverPaths(world.stateDir, id) }
}

async function publishedThenStopped() {
  const move = await verified()
  const record = readHandover(move.world.stateDir, move.id)!
  await publishSealed(move.world.stateDir, record)
  writeFileSync(move.paths.record, JSON.stringify(record))
  return move
}

const LOCK_TOKEN = 'a'.repeat(64)

/** A valid writer record for `pid`: the parent of this test process is live, 2^31-1 is not. */
async function writerRecord(stateDir: string, pid: number): Promise<string> {
  const path = join(stateDir, HOST_BRAIN_WRITER_LOCK)
  const processStart = await ownerLockPorts.processStart(pid)
  const body = {
    version: 1,
    pid,
    processStart,
    token: LOCK_TOKEN,
    startedAt: '2026-11-01T00:00:00.000Z',
  }
  writeFileSync(path, JSON.stringify(body) + '\n', { mode: 0o600 })
  return path
}

/** A crash inside lock reclamation: the gate stays, older than the 30-second stuck limit. */
function interruptedGate(stateDir: string): string {
  const gate = join(stateDir, `${HOST_BRAIN_WRITER_LOCK}-recovery`)
  mkdirSync(gate, { mode: 0o700 })
  const old = new Date(Date.now() - 120_000)
  utimesSync(gate, old, old)
  return gate
}

function recovery(world: ReturnType<typeof handoverWorld>) {
  const events: [string, Record<string, unknown> | undefined][] = []
  const ports = world.ports()
  return {
    events,
    run: () =>
      recoverBrainHandover({
        stateDir: world.stateDir,
        importAgentTranscripts: ports.importAgentTranscripts,
        log: (event, fields) => events.push([event, fields]),
      }),
  }
}

describe('Brain handover behind the shared writer lock', () => {
  it('defers startup recovery while a Host process with another config holds the writer', async () => {
    const { world, id, paths } = await publishedThenStopped()
    const lock = await writerRecord(world.stateDir, process.ppid)
    const recover = recovery(world)
    await recover.run()
    expect(readHandover(world.stateDir, id)?.state).toBe('verified')
    expect(world.imported.calls).toHaveLength(0)
    expect(existsSync(paths.sealed)).toBe(true)
    expect(recover.events).toEqual([['brain.handover.recovery-held', { reason: 'writer-busy' }]])
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: process.ppid })
  })

  it('refuses every mutating call while another process holds the writer; status still answers', async () => {
    const { world, host, id, paths } = await verified()
    await writerRecord(world.stateDir, process.ppid)
    const busy = expect.objectContaining({
      code: 'forbidden',
      message: 'Brain is open elsewhere on this Host.',
    })
    await expect(host['owner.brainHandover.commit']({ migrationId: id })).rejects.toEqual(busy)
    await expect(host['owner.brainHandover.abort']({ migrationId: id })).rejects.toEqual(busy)
    await expect(
      host['owner.brainHandover.begin']({ migrationId: world.migrationId(), ...BEGIN }),
    ).rejects.toEqual(busy)
    expect(readHandover(world.stateDir, id)?.state).toBe('verified')
    expect(existsSync(paths.target)).toBe(false)
    expect(existsSync(paths.sealed)).toBe(true)
    expect(world.imported.calls).toHaveLength(0)
    expect(await host['owner.brainHandover.status']({ migrationId: id })).toMatchObject({
      state: 'verified',
    })
  })

  it('reclaims a killed writer’s lock and then recovers', async () => {
    const { world, id } = await publishedThenStopped()
    await writerRecord(world.stateDir, 2147483647)
    await recovery(world).run()
    expect(readHandover(world.stateDir, id)?.state).toBe('committed')
    expect(existsSync(join(world.stateDir, HOST_BRAIN_WRITER_LOCK))).toBe(false)
  })

  it('keeps an interrupted reclamation’s gate and says how to repair it, without paths', async () => {
    const { world, host, id } = await publishedThenStopped()
    const lock = await writerRecord(world.stateDir, 2147483647)
    const gate = interruptedGate(world.stateDir)
    const recover = recovery(world)
    await recover.run()
    expect(recover.events).toEqual([['brain.handover.recovery-held', { reason: 'writer-repair' }]])
    expect(readHandover(world.stateDir, id)?.state).toBe('verified')
    const refusal: unknown = await host['owner.brainHandover.commit']({ migrationId: id }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refusal).toEqual(
      expect.objectContaining({
        code: 'forbidden',
        message: expect.stringContaining(`${HOST_BRAIN_WRITER_LOCK}-recovery`),
      }),
    )
    const message = (refusal as Error).message
    expect(message).not.toContain(world.stateDir)
    expect(message.length).toBeLessThanOrEqual(240)
    expect(readHandover(world.stateDir, id)?.state).toBe('verified')
    expect(existsSync(gate)).toBe(true)
    expect(existsSync(lock)).toBe(true)
  })

  it('shares this process’s own Brain writer: a handover beside an open Brain never deadlocks', async () => {
    const { world, host, id } = await verified()
    const brainWriter = hostBrainWriter(world.stateDir)
    await brainWriter.take()
    try {
      expect(await host['owner.brainHandover.commit']({ migrationId: id })).toEqual({
        state: 'committed',
      })
      expect(brainWriter.held()).toBe(true)
      expect(existsSync(join(world.stateDir, HOST_BRAIN_WRITER_LOCK))).toBe(true)
    } finally {
      await brainWriter.release()
    }
    expect(existsSync(join(world.stateDir, HOST_BRAIN_WRITER_LOCK))).toBe(false)
  })

  it('reads the record again after the reader check and never publishes a move aborted meanwhile', async () => {
    const { world, id, paths } = await verified()
    const host = world.restart({
      readerReadiness: async () => {
        writeRecord(paths.record, { ...readHandover(world.stateDir, id)!, state: 'aborted' })
        return 'qualified'
      },
    })
    await expect(host['owner.brainHandover.commit']({ migrationId: id })).rejects.toEqual(
      expect.objectContaining({ code: 'forbidden' }),
    )
    expect(existsSync(paths.target)).toBe(false)
    expect(readHandover(world.stateDir, id)?.state).toBe('aborted')
  })
})
