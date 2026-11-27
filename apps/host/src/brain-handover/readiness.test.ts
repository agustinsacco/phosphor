import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACTIVE, BEGIN, MODEL_FILE, handoverWorld, stageBrain } from './__fixtures__/staged-brain'
import { hostBrainAdmission } from './gate'
import { handoverPaths, readHandover } from './layout'

const worlds: ReturnType<typeof handoverWorld>[] = []
afterEach(() => {
  for (const world of worlds.splice(0)) world.dispose()
})
async function staged(over: Parameters<ReturnType<typeof handoverWorld>['restart']>[0] = {}) {
  const world = handoverWorld()
  worlds.push(world)
  const host = world.restart(over)
  const id = world.migrationId()
  const { staging } = await host['owner.brainHandover.begin']({ migrationId: id, ...BEGIN })
  return { world, host, id, staging, files: stageBrain(staging) }
}
const refusal = (code: string, message: string) =>
  expect.objectContaining({ code, message: expect.stringContaining(message) })

describe('final readiness before Desktop gives up its Brain', () => {
  it('runs the model probe on the sealed copy, never on the staged one', async () => {
    const { world, host, id, files } = await staged()
    await host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: ACTIVE })
    expect(world.imported.probed).toEqual([
      join(handoverPaths(world.stateDir, id).sealed, 'brain', 'embeddings'),
    ])
  })

  it('refuses verification when the model did not arrive, leaving the target untouched', async () => {
    const { world, host, id, staging, files } = await staged()
    unlinkSync(join(staging, MODEL_FILE))
    const without = files.filter((f) => f.name !== MODEL_FILE)
    await expect(
      host['owner.brainHandover.verify']({
        migrationId: id,
        files: without,
        activeTranscript: ACTIVE,
      }),
    ).rejects.toEqual(refusal('bad-request', 'embedding model'))
    expect(world.imported.probed).toEqual([])
    expect(readHandover(world.stateDir, id)?.state).toBe('staged')
    expect(existsSync(handoverPaths(world.stateDir).target)).toBe(false)
  })

  it('refuses verification when the moved model does not run', async () => {
    const { world, host, id, files } = await staged()
    world.imported.usable = false
    await expect(
      host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: ACTIVE }),
    ).rejects.toEqual(refusal('bad-request', 'model did not run'))
    expect(readHandover(world.stateDir, id)?.state).toBe('staged')
  })

  it('does not offer a move without a model probe', async () => {
    const world = handoverWorld()
    worlds.push(world)
    const host = world.restart({ probeModel: undefined })
    expect((await host['owner.brainHandover.status']({})).support.handover).toBe(false)
    await expect(
      host['owner.brainHandover.begin']({ migrationId: world.migrationId(), ...BEGIN }),
    ).rejects.toEqual(refusal('forbidden', 'cannot take a Brain'))
  })

  it('rechecks the reader before publishing and keeps the target empty when it is gone', async () => {
    let readiness: 'qualified' | 'unavailable' = 'qualified'
    const { world, host, id, files } = await staged({ readerReadiness: async () => readiness })
    await host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: ACTIVE })
    readiness = 'unavailable'
    await expect(host['owner.brainHandover.commit']({ migrationId: id })).rejects.toEqual(
      refusal('forbidden', 'reader'),
    )
    expect(existsSync(handoverPaths(world.stateDir).target)).toBe(false)
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'handover', migrationId: id })
  })
})

describe('the Brain Agent conversation that resumes', () => {
  it('names the active transcript in the report and hands it to the importer', async () => {
    const { world, host, id, files } = await staged()
    const { report } = await host['owner.brainHandover.verify']({
      migrationId: id,
      files,
      activeTranscript: ACTIVE,
    })
    expect(report.agent).toEqual({ transcripts: 1, rules: true, active: true })
    await host['owner.brainHandover.commit']({ migrationId: id })
    expect(world.imported.calls[0]?.active).toBe('brain-agent-1.jsonl')
  })

  it('refuses history without a named active transcript rather than start fresh', async () => {
    const { host, id, files } = await staged()
    await expect(
      host['owner.brainHandover.verify']({ migrationId: id, files, activeTranscript: null }),
    ).rejects.toEqual(refusal('bad-request', 'which Brain Agent conversation'))
  })

  it('accepts no active transcript when there is no history', async () => {
    const { host, id, staging, files } = await staged()
    unlinkSync(join(staging, ACTIVE))
    const { report } = await host['owner.brainHandover.verify']({
      migrationId: id,
      files: files.filter((f) => f.name !== ACTIVE),
      activeTranscript: null,
    })
    expect(report.agent).toEqual({ transcripts: 0, rules: true, active: false })
  })

  it('refuses an active transcript whose header is not a pi session', async () => {
    const { host, id, staging, files } = await staged()
    writeFileSync(join(staging, ACTIVE), 'not a transcript\n')
    const { describeFile } = await import('./__fixtures__/staged-brain')
    const changed = files.map((f) => (f.name === ACTIVE ? describeFile(staging, ACTIVE) : f))
    await expect(
      host['owner.brainHandover.verify']({
        migrationId: id,
        files: changed,
        activeTranscript: ACTIVE,
      }),
    ).rejects.toEqual(refusal('bad-request', 'session header'))
  })
})
