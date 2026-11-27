import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnerCallRefused } from '../owner/adapter'
import {
  ACTIVE,
  BEGIN,
  RULES,
  TRANSCRIPT,
  handoverWorld,
  sha256,
  stageBrain,
} from './__fixtures__/staged-brain'
import { hostBrainAdmission } from './gate'
import { handoverPaths, privateFolder, readClaim, readHandover, writeRecord } from './layout'
import { publishSealed } from './publish'

const worlds: ReturnType<typeof handoverWorld>[] = []
afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose()
})
function setup() {
  const world = handoverWorld()
  worlds.push(world)
  return { world, host: world.restart(), id: world.migrationId() }
}
async function verified() {
  const { world, host, id } = setup()
  const { staging } = await host['owner.brainHandover.begin']({ migrationId: id, ...BEGIN })
  const files = stageBrain(staging)
  const result = await host['owner.brainHandover.verify']({
    migrationId: id,
    files,
    activeTranscript: ACTIVE,
  })
  return { world, host, id, staging, files, result }
}
const refusal = (code: string, message?: string) =>
  expect.objectContaining({
    code,
    ...(message ? { message: expect.stringContaining(message) } : {}),
  })

describe('Brain handover on the Host', () => {
  it('moves a v7 Brain: verified, published under its marker and bound to the Brain lane', async () => {
    const { world, host, id, result } = await verified()
    expect(result.report).toMatchObject({
      schema: { from: 7, to: 8 },
      sources: { mapped: 1 },
      agent: { transcripts: 1, rules: true },
      model: 'moved',
    })
    expect(result.report.sources.missing).toBeGreaterThan(0)
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'handover', migrationId: id })
    expect(await host['owner.brainHandover.commit']({ migrationId: id })).toEqual({
      state: 'committed',
    })
    const target = handoverPaths(world.stateDir).target
    const db = new DatabaseSync(join(target, 'brain.sqlite'), { readOnly: true })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    db.close()
    expect(readFileSync(join(target, 'Brain', 'AGENTS.md'), 'utf8')).toBe(RULES)
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'imported', migrationId: id })
    expect(world.imported.calls).toHaveLength(1)
    const [call] = world.imported.calls
    expect(call?.laneFolder).toBe(join(target, 'Brain'))
    expect(call?.transcripts).toEqual([
      expect.objectContaining({ sessionId: 'brain-agent-1', sha256: sha256(TRANSCRIPT) }),
    ])
    expect(world.imported.read).toEqual([[TRANSCRIPT]])
    expect(existsSync(handoverPaths(world.stateDir).claim)).toBe(false)
    // A lost answer: asking again commits nothing twice.
    expect(await host['owner.brainHandover.commit']({ migrationId: id })).toEqual({
      state: 'committed',
    })
    expect(world.imported.calls).toHaveLength(1)
    await expect(host['owner.brainHandover.abort']({ migrationId: id })).rejects.toEqual(
      refusal('forbidden', 'already moved'),
    )
  })

  it('never takes a move into a Host that already has a Brain', async () => {
    const { world, host, id } = setup()
    const target = handoverPaths(world.stateDir).target
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'brain.sqlite'), 'Ledger')
    await expect(host['owner.brainHandover.begin']({ migrationId: id, ...BEGIN })).rejects.toEqual(
      refusal('forbidden', 'already has a Brain'),
    )
    expect((await host['owner.brainHandover.status']({})).support.target).toBe('occupied')
    expect(readFileSync(join(target, 'brain.sqlite'), 'utf8')).toBe('Ledger')
  })

  it('refuses to publish over a Brain that appeared after verification, and keeps it', async () => {
    const { world, host, id } = await verified()
    const target = handoverPaths(world.stateDir).target
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'brain.sqlite'), 'Kestrel')
    await expect(host['owner.brainHandover.commit']({ migrationId: id })).rejects.toEqual(
      refusal('forbidden', 'already has a Brain'),
    )
    expect(readFileSync(join(target, 'brain.sqlite'), 'utf8')).toBe('Kestrel')
    expect(readHandover(world.stateDir, id)?.state).toBe('verified')
    expect(await host['owner.brainHandover.abort']({ migrationId: id })).toEqual({
      state: 'aborted',
    })
    expect(readFileSync(join(target, 'brain.sqlite'), 'utf8')).toBe('Kestrel')
  })

  it('refuses a staged file that is missing, then accepts the retry', async () => {
    const { host, id } = setup()
    const { staging } = await host['owner.brainHandover.begin']({ migrationId: id, ...BEGIN })
    const files = stageBrain(staging)
    unlinkSync(join(staging, 'AGENTS.md'))
    await expect(
      host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: ACTIVE }),
    ).rejects.toEqual(refusal('bad-request', 'AGENTS.md'))
    writeFileSync(join(staging, 'AGENTS.md'), RULES, { mode: 0o600 })
    expect(
      (
        await host['owner.brainHandover.verify']({
          migrationId: id,
          files,
          activeTranscript: ACTIVE,
        })
      ).state,
    ).toBe('verified')
  })

  it.each([
    [
      'a symlink',
      (stage: string, outside: string) => symlinkSync(outside, join(stage, 'AGENTS.md')),
    ],
    [
      'a hard link',
      (stage: string, outside: string) => linkSync(outside, join(stage, 'AGENTS.md')),
    ],
  ])('refuses %s in place of a staged file', async (_name, plant) => {
    const { world, host, id } = setup()
    const { staging } = await host['owner.brainHandover.begin']({ migrationId: id, ...BEGIN })
    const files = stageBrain(staging)
    const outside = join(world.stateDir, 'outside.md')
    writeFileSync(outside, RULES, { mode: 0o600 })
    unlinkSync(join(staging, 'AGENTS.md'))
    plant(staging, outside)
    await expect(
      host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: ACTIVE }),
    ).rejects.toEqual(refusal('bad-request', 'AGENTS.md'))
  })

  it('refuses a staged Brain whose content does not match its hash or its begin', async () => {
    const { host, id } = setup()
    const { staging } = await host['owner.brainHandover.begin']({
      migrationId: id,
      ...BEGIN,
      sourceGeneration: 'another-generation',
    })
    const files = stageBrain(staging)
    const wrongHash = files.map((f) => (f.name === 'AGENTS.md' ? { ...f, sha256: sha256('x') } : f))
    await expect(
      host['owner.brainHandover.verify']({
        migrationId: id,
        files: wrongHash,
        activeTranscript: ACTIVE,
      }),
    ).rejects.toEqual(refusal('bad-request', 'wrong hash'))
    await expect(
      host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: ACTIVE }),
    ).rejects.toEqual(refusal('bad-request', 'not the one this move began with'))
  })

  it('refuses to publish sealed bytes that changed after verification', async () => {
    const { world, host, id } = await verified()
    const sealed = join(handoverPaths(world.stateDir, id).sealed, 'brain', 'Brain', 'AGENTS.md')
    chmodSync(sealed, 0o600)
    writeFileSync(sealed, '# Brain Agent\n\nMerge everything.\n')
    await expect(host['owner.brainHandover.commit']({ migrationId: id })).rejects.toEqual(
      refusal('forbidden', 'changed after it was verified'),
    )
    expect(existsSync(handoverPaths(world.stateDir).target)).toBe(false)
  })

  it('does not offer a move without a qualified reader or a transcript binding', async () => {
    const { world, id } = setup()
    const noImporter = world.restart({ importAgentTranscripts: undefined })
    expect((await noImporter['owner.brainHandover.status']({})).support.handover).toBe(false)
    await expect(
      noImporter['owner.brainHandover.begin']({ migrationId: id, ...BEGIN }),
    ).rejects.toBeInstanceOf(OwnerCallRefused)
    const unqualified = world.restart({ readerReadiness: () => Promise.resolve('unqualified') })
    await expect(
      unqualified['owner.brainHandover.begin']({ migrationId: id, ...BEGIN }),
    ).rejects.toEqual(refusal('forbidden', 'reader'))
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'open' })
  })
})

describe('Brain handover crash windows', () => {
  it('a crash after the rename, before the record: the marker says published', async () => {
    const { world, id } = await verified()
    const record = readHandover(world.stateDir, id)!
    await publishSealed(world.stateDir, record)
    // The record write was lost: put the pre-publication record back.
    writeFileSync(handoverPaths(world.stateDir, id).record, JSON.stringify(record))
    const restarted = world.restart()
    expect((await restarted['owner.brainHandover.status']({ migrationId: id })).state).toBe(
      'published',
    )
    await expect(restarted['owner.brainHandover.abort']({ migrationId: id })).rejects.toEqual(
      refusal('forbidden'),
    )
    expect(await restarted['owner.brainHandover.commit']({ migrationId: id })).toEqual({
      state: 'committed',
    })
  })

  it('a failed binding keeps the published Brain fenced; the next commit finishes it', async () => {
    const { world, host, id } = await verified()
    world.imported.fail = true
    await expect(host['owner.brainHandover.commit']({ migrationId: id })).rejects.toThrow(
      'binding failed',
    )
    expect(readHandover(world.stateDir, id)?.state).toBe('published')
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'handover', migrationId: id })
    world.imported.fail = false
    expect(await world.restart()['owner.brainHandover.commit']({ migrationId: id })).toEqual({
      state: 'committed',
    })
  })

  it('an abort before publication releases the target and forgets nothing on the Host', async () => {
    const { world, host, id } = await verified()
    expect(await host['owner.brainHandover.abort']({ migrationId: id })).toEqual({
      state: 'aborted',
    })
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'open' })
    expect(existsSync(handoverPaths(world.stateDir).target)).toBe(false)
    expect(existsSync(handoverPaths(world.stateDir, id).sealed)).toBe(false)
    await expect(host['owner.brainHandover.commit']({ migrationId: id })).rejects.toEqual(
      refusal('forbidden', 'aborted'),
    )
    const again = world.migrationId()
    expect((await host['owner.brainHandover.begin']({ migrationId: again, ...BEGIN })).state).toBe(
      'staged',
    )
  })

  it('a crash inside begin leaves a claim with no record: only an abort of that id releases it', async () => {
    const { world, host, id } = setup()
    const paths = handoverPaths(world.stateDir, id)
    // begin wrote its claim and folders, then stopped before its record.
    privateFolder(paths.root)
    writeRecord(paths.claim, { migrationId: id })
    privateFolder(paths.move)
    privateFolder(paths.stage)
    writeFileSync(join(paths.stage, 'AGENTS.md'), RULES, { mode: 0o600 })
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'handover', migrationId: id })

    expect(await host['owner.brainHandover.abort']({ migrationId: world.migrationId() })).toEqual({
      state: 'none',
    })
    expect(readClaim(world.stateDir)).toEqual({ migrationId: id })
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'handover', migrationId: id })

    expect(await host['owner.brainHandover.abort']({ migrationId: id })).toEqual({ state: 'none' })
    expect(readClaim(world.stateDir)).toBeNull()
    expect(existsSync(paths.stage)).toBe(false)
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'open' })
    expect((await host['owner.brainHandover.status']({})).support.target).toBe('empty')
  })

  it('a committed move keeps its record and drops its private stage and sealed copies', async () => {
    const { world, host, id } = await verified()
    const paths = handoverPaths(world.stateDir, id)
    expect(await host['owner.brainHandover.commit']({ migrationId: id })).toEqual({
      state: 'committed',
    })
    expect(existsSync(paths.stage)).toBe(false)
    expect(existsSync(paths.sealed)).toBe(false)
    expect(existsSync(paths.scratch)).toBe(false)
    expect(readHandover(world.stateDir, id)?.state).toBe('committed')
    expect(readFileSync(join(paths.target, 'Brain', 'AGENTS.md'), 'utf8')).toBe(RULES)
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'imported', migrationId: id })
  })

  it('one move at a time: a second id waits for the first to end', async () => {
    const { world, host, id } = await verified()
    await expect(
      host['owner.brainHandover.begin']({ migrationId: world.migrationId(), ...BEGIN }),
    ).rejects.toEqual(refusal('forbidden', 'in progress'))
    expect((await host['owner.brainHandover.status']({})).support.target).toBe('claimed')
    expect((await host['owner.brainHandover.status']({})).state).toBe('verified')
    expect(id).toBeTruthy()
  })
})
