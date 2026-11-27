import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnerCallError } from '@phosphor/host-client/owner'
import { openBrainStore } from '@phosphor/memory-engine/store'
import type { OwnerCalls, OwnerMethod } from '@phosphor/shared/host-protocol-owner'
import { createBrainHandoverHandlers } from '../../../../host/src/brain-handover/handlers'
import { hostBrainAdmission } from '../../../../host/src/brain-handover/gate'
import { handoverPaths } from '../../../../host/src/brain-handover/layout'
import { OwnerCallRefused } from '../../../../host/src/owner/adapter'
import {
  brainHandoverPaths,
  desktopBrainOwner,
  isBrainTombstoneFile,
  readBrainHandoverRecord,
  writeBrainHandoverRecord,
} from '../../brain/owner-gate'
import {
  resolveBrainHandover,
  runBrainHandover,
  type BrainHandoverChannel,
  type BrainHandoverRunPorts,
} from './runner'
import { installBrainTombstone } from './tombstone'

const V7 = new URL(
  '../../../../../libs/memory-engine/src/__fixtures__/schema-v7.sql',
  import.meta.url,
)
const RULES = '# Brain Agent\n\nCheck with Rina Okafor before folding Ledger memories.\n'
const HEADER = JSON.stringify({ type: 'session', version: 3, id: 'brain-agent-7', cwd: '/x' })
const OLDER = JSON.stringify({ type: 'session', version: 3, id: 'brain-agent-6', cwd: '/x' })
const MODEL = '{"model":"northwind-synthetic"}\n'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
const temp = (name: string) => {
  const folder = mkdtempSync(join(tmpdir(), `${name}-`))
  folders.push(folder)
  return folder
}
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

type FakeHost = ReturnType<typeof createBrainHandoverHandlers>

/** The owner socket: a refusal arrives as its code, anything else as `internal`. */
function ownerSocket(host: FakeHost) {
  const channel: BrainHandoverChannel & {
    fail?: (method: OwnerMethod) => 'before' | 'after' | null
  } = {
    async call<M extends OwnerMethod>(method: M, params: OwnerCalls[M]['params']) {
      const fail = channel.fail?.(method) ?? null
      if (fail === 'before') throw new OwnerCallError('internal', 'lost')
      const handler = host[method as keyof typeof host] as unknown as (
        p: OwnerCalls[M]['params'],
      ) => Promise<OwnerCalls[M]['result']>
      try {
        const result = await handler(params)
        if (fail === 'after') throw new OwnerCallError('internal', 'lost')
        return result
      } catch (error) {
        if (error instanceof OwnerCallRefused) throw new OwnerCallError(error.code, error.message)
        throw error
      }
    },
  }
  return channel
}

/** This Mac: a v7 Desktop Brain with rules and one Brain Agent transcript, and its service. */
function mac(
  options: { brain?: boolean; transcript?: string; model?: boolean; usable?: boolean } = {},
) {
  const userData = temp('harbor-desktop')
  const laneFolder = join(userData, 'brain', 'Brain')
  const transcripts = temp('harbor-transcripts')
  mkdirSync(laneFolder, { recursive: true })
  writeFileSync(join(laneFolder, 'AGENTS.md'), RULES)
  // Desktop resumes its newest transcript; an older one is history that must move too.
  writeFileSync(join(transcripts, 'older.jsonl'), `${OLDER}\n`)
  utimesSync(join(transcripts, 'older.jsonl'), new Date('2026-09-01'), new Date('2026-09-01'))
  writeFileSync(join(transcripts, 'agent.jsonl'), options.transcript ?? `${HEADER}\n`)
  const modelFolder = join(userData, 'brain', 'embeddings', 'embedding-models', 'model')
  if (options.model !== false) {
    mkdirSync(modelFolder, { recursive: true })
    writeFileSync(join(modelFolder, 'config.json'), MODEL)
  }
  const legacy = brainHandoverPaths(userData).legacy
  if (options.brain !== false) {
    const db = new DatabaseSync(legacy)
    db.exec(readFileSync(V7, 'utf8'))
    db.close()
  }
  const stateDir = temp('harbor-service')
  const bound: string[] = []
  const active: (string | null)[] = []
  const host = createBrainHandoverHandlers({
    stateDir,
    uid: process.getuid?.(),
    now: () => Date.parse('2026-11-01'),
    laneForSessionFile: () => true,
    readerReadiness: () => Promise.resolve('qualified'),
    embeddingModel: {
      directoryName: 'model',
      files: [{ path: 'config.json', bytes: Buffer.byteLength(MODEL), sha256: hash(MODEL) }],
    },
    probeModel: () => Promise.resolve(options.usable !== false),
    importAgentTranscripts: (input) => {
      bound.push(...input.transcripts.map((t) => t.sessionId))
      active.push(input.active)
      return Promise.resolve({ bound: input.active })
    },
  })
  const channel = ownerSocket(host)
  const ports: BrainHandoverRunPorts = {
    userData,
    desktopVersion: '1.2.3',
    sources: {
      sqlite: { DatabaseSync, backup },
      database: legacy,
      laneFolder,
      transcripts,
      model: {
        folder: modelFolder,
        directoryName: 'model',
        files: [{ path: 'config.json', bytes: Buffer.byteLength(MODEL) }],
      },
    },
    newId: () => '00000000-0000-4000-8000-0000000000aa',
    wait: () => Promise.resolve(),
  }
  return { userData, legacy, stateDir, host, channel, ports, bound, active }
}

describe('moving the Desktop Brain to This Mac’s service', () => {
  it('commits once: the service owns a verified copy, Desktop keeps the original fenced', async () => {
    const world = mac()
    const before = sha(world.legacy)
    expect(await runBrainHandover(world.ports, world.channel)).toBe('moved')
    expect(desktopBrainOwner(world.userData)).toBe('host')
    expect(hostBrainAdmission(world.stateDir)).toMatchObject({ state: 'imported' })
    expect(world.bound).toEqual(['brain-agent-7', 'brain-agent-6'])
    expect(world.active).toEqual(['agent.jsonl'])
    const target = handoverPaths(world.stateDir).target
    expect(readFileSync(join(target, 'Brain', 'AGENTS.md'), 'utf8')).toBe(RULES)
    // The original keeps its bytes under a second name; the legacy path refuses every build.
    const original = brainHandoverPaths(world.userData, '00000000-0000-4000-8000-0000000000aa')
    expect(sha(original.original)).toBe(before)
    expect(isBrainTombstoneFile(world.legacy)).toBe(true)
    expect(() => openBrainStore({ path: world.legacy, Database: DatabaseSync })).toThrow(
      'requires a newer application',
    )
    // The next launch has nothing left to do.
    expect(await runBrainHandover(world.ports, world.channel)).toBe('moved')
  })

  it('defers when the service already has a Brain, touching neither', async () => {
    const world = mac()
    const target = handoverPaths(world.stateDir).target
    mkdirSync(target)
    writeFileSync(join(target, 'brain.sqlite'), 'Northwind')
    const before = sha(world.legacy)
    expect(await runBrainHandover(world.ports, world.channel)).toBe('deferred')
    expect(desktopBrainOwner(world.userData)).toBe('desktop')
    expect(readBrainHandoverRecord(world.userData)).toBeNull()
    expect(sha(world.legacy)).toBe(before)
    expect(readFileSync(join(target, 'brain.sqlite'), 'utf8')).toBe('Northwind')
  })

  it('defers before fencing when the embedding model is not on this Mac', async () => {
    const world = mac({ model: false })
    expect(await runBrainHandover(world.ports, world.channel)).toBe('deferred')
    expect(readBrainHandoverRecord(world.userData)).toBeNull()
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'open' })
  })

  it('keeps the Desktop Brain when the service cannot run the moved model', async () => {
    const world = mac({ usable: false })
    const before = sha(world.legacy)
    expect(await runBrainHandover(world.ports, world.channel)).toBe('aborted')
    expect(desktopBrainOwner(world.userData)).toBe('desktop')
    expect(isBrainTombstoneFile(world.legacy)).toBe(false)
    expect(sha(world.legacy)).toBe(before)
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'open' })
  })

  it('has nothing to move without a Desktop Brain', async () => {
    const world = mac({ brain: false })
    expect(await runBrainHandover(world.ports, world.channel)).toBe('none')
    expect(existsSync(handoverPaths(world.stateDir).target)).toBe(false)
  })

  it('aborts both sides when the service refuses what was staged', async () => {
    const world = mac({ transcript: 'not a transcript\n' })
    const before = sha(world.legacy)
    expect(await runBrainHandover(world.ports, world.channel)).toBe('aborted')
    expect(desktopBrainOwner(world.userData)).toBe('desktop')
    expect(sha(world.legacy)).toBe(before)
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'open' })
  })

  it('restores the original when the service refuses to publish after the tombstone', async () => {
    const world = mac()
    const before = sha(world.legacy)
    world.channel.fail = (method) => {
      if (method === 'owner.brainHandover.commit') {
        const target = handoverPaths(world.stateDir).target
        mkdirSync(target, { recursive: true })
        writeFileSync(join(target, 'brain.sqlite'), 'Kestrel')
      }
      return null
    }
    expect(await runBrainHandover(world.ports, world.channel)).toBe('aborted')
    expect(desktopBrainOwner(world.userData)).toBe('desktop')
    expect(isBrainTombstoneFile(world.legacy)).toBe(false)
    expect(sha(world.legacy)).toBe(before)
    expect(readFileSync(join(handoverPaths(world.stateDir).target, 'brain.sqlite'), 'utf8')).toBe(
      'Kestrel',
    )
  })
})

describe('Brain move crash windows', () => {
  it('a lost commit answer: the service committed, so Desktop records it', async () => {
    const world = mac()
    world.channel.fail = (method) => (method === 'owner.brainHandover.commit' ? 'after' : null)
    const first = await runBrainHandover(world.ports, world.channel)
    // The recovery commit is lost too: Desktop stays fenced rather than guess.
    expect(first).toBe('pending')
    expect(desktopBrainOwner(world.userData)).toBe('moving')
    world.channel.fail = undefined
    expect(await runBrainHandover(world.ports, world.channel)).toBe('moved')
    expect(desktopBrainOwner(world.userData)).toBe('host')
  })

  it('a commit that never arrived resumes by id and commits once', async () => {
    const world = mac()
    let lost = 1
    world.channel.fail = (method) =>
      method === 'owner.brainHandover.commit' && lost-- > 0 ? 'before' : null
    expect(await runBrainHandover(world.ports, world.channel)).toBe('moved')
    expect(world.active).toEqual(['agent.jsonl'])
  })

  it('a crash after the tombstone: no service means pending, the service settles it', async () => {
    const world = mac()
    const id = '00000000-0000-4000-8000-0000000000bb'
    const { staging } = await world.host['owner.brainHandover.begin']({
      migrationId: id,
      sourceSchema: 7,
      sourceGeneration: 'id-1',
      desktopVersion: '1.2.3',
    })
    const { stageDesktopBrain } = await import('./stage')
    const staged = await stageDesktopBrain(world.ports.sources, staging)
    await world.host['owner.brainHandover.verify']({ migrationId: id, ...staged })
    writeBrainHandoverRecord(world.userData, { version: 1, migrationId: id, phase: 'tombstoned' })
    installBrainTombstone(world.userData, id, DatabaseSync)
    expect(await resolveBrainHandover(world.ports, null)).toBe('pending')
    expect(desktopBrainOwner(world.userData)).toBe('moving')
    expect(await runBrainHandover(world.ports, world.channel)).toBe('moved')
  })

  it('a recorded tombstone that never landed: the original may have changed, so abort', async () => {
    const world = mac()
    const id = '00000000-0000-4000-8000-0000000000dd'
    const before = sha(world.legacy)
    const { staging } = await world.host['owner.brainHandover.begin']({
      migrationId: id,
      sourceSchema: 7,
      sourceGeneration: 'id-1',
      desktopVersion: '1.2.3',
    })
    const { stageDesktopBrain } = await import('./stage')
    const staged = await stageDesktopBrain(world.ports.sources, staging)
    await world.host['owner.brainHandover.verify']({ migrationId: id, ...staged })
    writeBrainHandoverRecord(world.userData, { version: 1, migrationId: id, phase: 'tombstoned' })
    expect(await runBrainHandover(world.ports, world.channel)).toBe('aborted')
    expect(desktopBrainOwner(world.userData)).toBe('desktop')
    expect(sha(world.legacy)).toBe(before)
    expect(existsSync(handoverPaths(world.stateDir).target)).toBe(false)
  })

  it('a crash while fenced: the service never published, so the original comes back', async () => {
    const world = mac()
    const id = '00000000-0000-4000-8000-0000000000cc'
    const before = sha(world.legacy)
    await world.host['owner.brainHandover.begin']({
      migrationId: id,
      sourceSchema: 7,
      sourceGeneration: 'id-1',
      desktopVersion: '1.2.3',
    })
    writeBrainHandoverRecord(world.userData, { version: 1, migrationId: id, phase: 'fenced' })
    expect(desktopBrainOwner(world.userData)).toBe('moving')
    expect(await runBrainHandover(world.ports, world.channel)).toBe('aborted')
    expect(desktopBrainOwner(world.userData)).toBe('desktop')
    expect(sha(world.legacy)).toBe(before)
    expect(hostBrainAdmission(world.stateDir)).toEqual({ state: 'open' })
  })
})
