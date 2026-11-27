import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACTIVE, BEGIN, TRANSCRIPT, handoverWorld, stageBrain } from './__fixtures__/staged-brain'
import { hostBrainAdmission } from './gate'
import { handoverPaths, readClaim, readHandover, writeRecord } from './layout'
import type { BrainHandoverNativePorts } from './owner-seam'
import { publishSealed } from './publish'
import { recoverBrainHandover, settleBrainHandover } from './recover'

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

/** Published, then the Host stopped before its record: only the marker says so. */
async function publishedThenStopped() {
  const move = await verified()
  const record = readHandover(move.world.stateDir, move.id)!
  await publishSealed(move.world.stateDir, record)
  writeFileSync(move.paths.record, JSON.stringify(record))
  return move
}

function recover(world: ReturnType<typeof handoverWorld>, withImporter = true) {
  const events: [string, Record<string, unknown> | undefined][] = []
  const ports = world.ports()
  return {
    events,
    run: () =>
      recoverBrainHandover({
        stateDir: world.stateDir,
        importAgentTranscripts: withImporter ? ports.importAgentTranscripts : undefined,
        log: (event, fields) => events.push([event, fields]),
      }),
  }
}

describe('Brain handover recovery at Host start', () => {
  it('commits a published move whose marker, record and seal agree, without Desktop', async () => {
    const { world, id, paths } = await publishedThenStopped()
    const recovery = recover(world)
    await recovery.run()
    expect(readHandover(world.stateDir, id)?.state).toBe('committed')
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'imported', migrationId: id })
    expect(world.imported.calls).toHaveLength(1)
    expect(world.imported.calls[0]).toMatchObject({
      migrationId: id,
      active: 'brain-agent-1.jsonl',
    })
    expect(world.imported.read).toEqual([[TRANSCRIPT]])
    expect(readClaim(world.stateDir)).toBeNull()
    for (const leftover of [paths.stage, paths.sealed, paths.scratch])
      expect(existsSync(leftover)).toBe(false)
    expect(recovery.events).toEqual([
      ['brain.handover.committed', { migrationId: id, recovered: true }],
    ])
    // Desktop's later commit is answered from the record; nothing binds twice.
    expect(await world.restart()['owner.brainHandover.commit']({ migrationId: id })).toEqual({
      state: 'committed',
    })
    await recover(world).run()
    expect(world.imported.calls).toHaveLength(1)
  })

  it('never publishes or commits a verified move: only Desktop’s commit does', async () => {
    const { world, id, paths } = await verified()
    await recover(world).run()
    expect(readHandover(world.stateDir, id)?.state).toBe('verified')
    expect(existsSync(paths.target)).toBe(false)
    expect(existsSync(paths.sealed)).toBe(true)
    expect(existsSync(paths.stage)).toBe(true)
    expect(readClaim(world.stateDir)).toEqual({ migrationId: id })
    expect(world.imported.calls).toHaveLength(0)
  })

  it.each([
    [
      'a marker from another source generation',
      ({ paths, id }: Awaited<ReturnType<typeof verified>>) =>
        writeRecord(paths.marker, { version: 1, migrationId: id, sourceGeneration: 'id-2' }),
      'generation',
    ],
    [
      'a published Brain file that no longer matches its seal',
      ({ paths }: Awaited<ReturnType<typeof verified>>) => {
        const rules = join(paths.target, 'Brain', 'AGENTS.md')
        chmodSync(rules, 0o600)
        writeFileSync(rules, '# Brain Agent\n\nMerge Ledger into Kestrel.\n')
      },
      'seal',
    ],
    [
      'a seal missing its database',
      ({ paths, world, id }: Awaited<ReturnType<typeof verified>>) => {
        const record = readHandover(world.stateDir, id)!
        writeRecord(paths.record, {
          ...record,
          sealed: record.sealed!.filter((file) => file.path !== 'brain/brain.sqlite'),
        })
      },
      'seal',
    ],
    [
      'a missing sealed transcript',
      ({ paths }: Awaited<ReturnType<typeof verified>>) => {
        chmodSync(join(paths.sealed, 'transcripts'), 0o700)
        rmSync(join(paths.sealed, ACTIVE))
      },
      'seal',
    ],
    [
      'a claim held by another move',
      ({ paths, world }: Awaited<ReturnType<typeof verified>>) =>
        writeRecord(paths.claim, { migrationId: world.migrationId() }),
      'claim',
    ],
  ])('holds the move fenced on %s', async (_name, tamper, reason) => {
    const move = await publishedThenStopped()
    tamper(move)
    const recovery = recover(move.world)
    await recovery.run()
    expect(readHandover(move.world.stateDir, move.id)?.state).not.toBe('committed')
    expect(hostBrainAdmission(move.world.stateDir)).toEqual({
      state: 'handover',
      migrationId: move.id,
    })
    expect(move.world.imported.calls).toHaveLength(0)
    expect(existsSync(move.paths.sealed)).toBe(true)
    expect(recovery.events).toEqual([
      ['brain.handover.recovery-held', { migrationId: move.id, reason }],
    ])
  })

  it('without the reserved lane’s importer, a published move waits for a Host that has one', async () => {
    const { world, id, paths } = await publishedThenStopped()
    const recovery = recover(world, false)
    await recovery.run()
    expect(readHandover(world.stateDir, id)?.state).toBe('verified')
    expect(existsSync(paths.sealed)).toBe(true)
    expect(recovery.events).toEqual([
      ['brain.handover.recovery-held', { migrationId: id, reason: 'importer' }],
    ])
  })

  it('a failed binding leaves the move published and its sealed copies for the next attempt', async () => {
    const { world, id, paths } = await publishedThenStopped()
    world.imported.fail = true
    const recovery = recover(world)
    await recovery.run()
    expect(readHandover(world.stateDir, id)?.state).toBe('published')
    expect(existsSync(join(paths.sealed, ACTIVE))).toBe(true)
    expect(recovery.events).toEqual([['brain.handover.recovery-failed', undefined]])
    world.imported.fail = false
    await recover(world).run()
    expect(readHandover(world.stateDir, id)?.state).toBe('committed')
  })

  it('drops settled moves’ leftover copies and keeps unfinished and unreadable moves whole', async () => {
    const settled = await verified()
    const { world } = settled
    // An earlier build committed without dropping its copies.
    writeRecord(settled.paths.record, {
      ...readHandover(world.stateDir, settled.id)!,
      state: 'committed',
    })
    mkdirSync(settled.paths.scratch, { mode: 0o700 })
    writeFileSync(join(settled.paths.move, 'Northwind.txt'), 'kept')
    const unfinished = handoverPaths(world.stateDir, world.migrationId())
    mkdirSync(unfinished.stage, { recursive: true, mode: 0o700 })
    writeRecord(unfinished.record, {
      ...readHandover(world.stateDir, settled.id)!,
      migrationId: unfinished.move.split('/').pop()!,
      state: 'staged',
    })
    const unreadable = handoverPaths(world.stateDir, world.migrationId())
    mkdirSync(unreadable.stage, { recursive: true, mode: 0o700 })
    writeFileSync(unreadable.record, '{"version":1')
    await recover(world).run()
    for (const leftover of [settled.paths.stage, settled.paths.sealed, settled.paths.scratch])
      expect(existsSync(leftover)).toBe(false)
    expect(readHandover(world.stateDir, settled.id)?.state).toBe('committed')
    expect(readFileSync(join(settled.paths.move, 'Northwind.txt'), 'utf8')).toBe('kept')
    expect(existsSync(unfinished.stage)).toBe(true)
    expect(existsSync(unreadable.stage)).toBe(true)
  })

  it('hands the owner socket its ports only after recovery', async () => {
    const { world, id } = await publishedThenStopped()
    const ports = world.ports()
    const slot: { current?: BrainHandoverNativePorts } = {}
    const seen: (BrainHandoverNativePorts | undefined)[] = []
    const native: Required<BrainHandoverNativePorts> = {
      readerReadiness: ports.readerReadiness,
      embeddingModel: ports.embeddingModel!,
      probeModel: ports.probeModel!,
      importAgentTranscripts: async (input) => {
        seen.push(slot.current)
        return await ports.importAgentTranscripts!(input)
      },
    }
    await settleBrainHandover(world.stateDir, native, slot, { write: () => {} })
    expect(seen).toEqual([undefined])
    expect(slot.current).toBe(native)
    expect(readHandover(world.stateDir, id)?.state).toBe('committed')
  })
})
