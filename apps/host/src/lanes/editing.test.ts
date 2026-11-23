import type * as NodeCrypto from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeProjectDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import {
  forkLane,
  jumpLaneTo,
  labelLaneEntry,
  laneLineage,
  LaneEditRefused,
  readLaneTree,
} from './editing'
import { editingFixture, line, transcript, type EditingFixture } from './__fixtures__/editing'

// The writer's ids, pinned as R2's bytes test pins them; lane ids stay distinct v4 UUIDs.
let uuids = 0
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return {
    ...actual,
    randomBytes: (size: number) =>
      size === 4 ? Buffer.from('11223344', 'hex') : actual.randomBytes(size),
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`,
  }
})

const NOW = '2026-09-01T12:00:00.000Z'
const JUMPED = 'Jumped here from another branch in Phosphor (tree view).'
const jumpLine = (parentId: string, fromId: string) =>
  `{"type":"branch_summary","id":"11223344","parentId":"${parentId}","timestamp":"${NOW}","fromId":"${fromId}","summary":"${JUMPED}"}\n`

let fx: EditingFixture

beforeEach(async () => {
  uuids = 0
  fx = await editingFixture()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  fx.close()
})

/** The header R2's writer gives a fork of `source`: fresh id and timestamp, parentSession. */
function forkHeader(id: string, source: string): string {
  return line({
    type: 'session',
    version: 3,
    id,
    timestamp: NOW,
    cwd: fx.repo,
    parentSession: source,
  })
}

function sessionFiles(): string[] {
  return readdirSync(fx.sessions).sort()
}

describe('fork, clone and rewind create a new lane and leave the source', () => {
  it('forks a stopped lane at an entry in R2’s bytes, beside an unchanged source', async () => {
    const lines = transcript(fx.repo)
    const source = fx.lane('source', lines)
    const before = readFileSync(source.sessionFile!, 'utf8')

    const forked = await forkLane(fx.ports, source, { kind: 'fork', at: 'a1', lineage: null })

    const headerId = '00000000-0000-4000-8000-000000000002'
    expect(readFileSync(forked.lane.sessionFile!, 'utf8')).toBe(
      forkHeader(headerId, source.sessionFile!) + lines.slice(1).join('') + jumpLine('a1', 'u2'),
    )
    expect(forked.lane.sessionFile).toBe(
      join(fx.sessions, `2026-09-01T12-00-00-000Z_${headerId}.jsonl`),
    )
    expect(readFileSync(source.sessionFile!, 'utf8')).toBe(before)
    expect(fx.store.getLane(source.laneId)).toEqual(source)
    expect(forked.lane).toMatchObject({
      repositoryId: source.repositoryId,
      cwd: source.cwd,
      worktree: false,
      title: 'Source',
      removedAt: null,
    })
    expect(forked.lane.laneId).not.toBe(source.laneId)
    expect(fx.announced).toEqual([forked.lane.laneId])
    expect(fx.prefs(forked.lane.laneId)).toEqual({})
  })

  it('forks a live lane too: only its complete lines are copied, and its file is never written', async () => {
    const lines = transcript(fx.repo)
    const source = fx.lane('live', lines)
    writeFileSync(source.sessionFile!, lines.join('') + '{"torn":')
    fx.open.add(source.sessionFile!)

    const forked = await forkLane(fx.ports, source, { kind: 'fork', lineage: null })

    expect(readFileSync(forked.lane.sessionFile!, 'utf8')).toBe(
      forkHeader('00000000-0000-4000-8000-000000000002', source.sessionFile!) +
        lines.slice(1).join(''),
    )
    expect(readFileSync(source.sessionFile!, 'utf8')).toBe(lines.join('') + '{"torn":')
  })

  it('clones at the leaf with no jump line, and forks the Claude ledger with it', async () => {
    const claude = join(fx.root, 'claude')
    const state = join(fx.root, 'claude-state')
    vi.stubEnv('CLAUDE_CONFIG_DIR', claude)
    vi.stubEnv('PI_CLAUDE_CLI_STATE_DIR', state)
    const piId = '11111111-1111-4111-8111-111111111111'
    const cliId = '22222222-2222-4222-8222-222222222222'
    mkdirSync(join(state, 'sysprompt'), { recursive: true })
    writeFileSync(join(state, 'session-map.json'), JSON.stringify({ [piId]: cliId }))
    mkdirSync(claudeProjectDirForCwd(fx.repo), { recursive: true })
    writeFileSync(
      join(claudeProjectDirForCwd(fx.repo), `${cliId}.jsonl`),
      line({ sessionId: cliId, type: 'user' }),
    )
    const lines = transcript(fx.repo, piId)
    const source = fx.lane('source', lines)

    const cloned = await forkLane(fx.ports, source, { kind: 'clone', lineage: null })

    const cloneId = '00000000-0000-4000-8000-000000000002'
    expect(readFileSync(cloned.lane.sessionFile!, 'utf8')).toBe(
      forkHeader(cloneId, source.sessionFile!) + lines.slice(1).join(''),
    )
    expect(cloned.ledgerForked).toBe(true)
    const map = JSON.parse(readFileSync(join(state, 'session-map.json'), 'utf8')) as Record<
      string,
      string
    >
    expect(map[piId]).toBe(cliId)
    const forkedCli = map[cloneId]!
    expect(forkedCli).not.toBe(cliId)
    expect(readFileSync(join(claudeProjectDirForCwd(fx.repo), `${forkedCli}.jsonl`), 'utf8')).toBe(
      line({ sessionId: forkedCli, type: 'user' }),
    )
  })

  it('clones a lane that never used Claude without a ledger, and refuses an entry that is not the leaf', async () => {
    vi.stubEnv('PI_CLAUDE_CLI_STATE_DIR', join(fx.root, 'claude-state'))
    const source = fx.lane('source', transcript(fx.repo))
    expect((await forkLane(fx.ports, source, { kind: 'clone', lineage: null })).ledgerForked).toBe(
      false,
    )
    await expect(
      forkLane(fx.ports, source, { kind: 'clone', at: 'a1', lineage: null }),
    ).rejects.toThrow(/use lane\.fork/)
  })

  it('rewinds to just before a user message, hands its text back and records the lane it replaces', async () => {
    const lines = transcript(fx.repo)
    const source = fx.lane('source', lines)

    const rewound = await forkLane(fx.ports, source, { kind: 'rewind', at: 'u2', lineage: null })

    expect(rewound.prefill).toBe('second')
    expect(rewound.ledgerForked).toBeUndefined()
    expect(readFileSync(rewound.lane.sessionFile!, 'utf8')).toBe(
      forkHeader('00000000-0000-4000-8000-000000000002', source.sessionFile!) +
        lines.slice(1).join('') +
        jumpLine('a1', 'u2'),
    )
    expect(fx.store.getLane(rewound.lane.laneId)).toMatchObject({ rewoundFrom: source.laneId })
    expect(fx.prefs(rewound.lane.laneId)).toEqual({ rewound_from: source.laneId })
    expect(fx.store.getLane(source.laneId)?.removedAt).toBeNull()
  })

  it('rewinds the first message into pi’s header-only file', async () => {
    const source = fx.lane('source', transcript(fx.repo))
    const rewound = await forkLane(fx.ports, source, { kind: 'rewind', at: 'u1', lineage: null })
    expect(rewound.prefill).toBe('first')
    expect(readFileSync(rewound.lane.sessionFile!, 'utf8')).toBe(
      forkHeader('00000000-0000-4000-8000-000000000002', source.sessionFile!),
    )
  })

  it('refuses a rewind to anything but a user message, and an entry the lane does not have', async () => {
    const source = fx.lane('source', transcript(fx.repo))
    await expect(
      forkLane(fx.ports, source, { kind: 'rewind', at: 'a1', lineage: null }),
    ).rejects.toThrow(LaneEditRefused)
    await expect(
      forkLane(fx.ports, source, { kind: 'fork', at: 'nope', lineage: null }),
    ).rejects.toThrow('No entry nope')
    expect(sessionFiles()).toEqual(['source.jsonl'])
  })

  it('records an agent’s lineage on its new lane', async () => {
    const source = fx.lane('source', transcript(fx.repo))
    const lineage = { createdBy: 'host:m/lane:asker', lineage: 2 }
    const forked = await forkLane(fx.ports, source, { kind: 'fork', lineage })
    expect(fx.prefs(forked.lane.laneId)).toEqual({ created_by: 'host:m/lane:asker', lineage: '2' })
  })

  it('leaves nothing behind when the machine has no room for another lane', async () => {
    fx.close()
    fx = await editingFixture({ limits: { lanesPerHost: 1 } })
    const source = fx.lane('source', transcript(fx.repo))
    await expect(forkLane(fx.ports, source, { kind: 'fork', lineage: null })).rejects.toThrow(
      /lane limit/,
    )
    expect(sessionFiles()).toEqual(['source.jsonl'])
    expect(fx.announced).toEqual([])
  })

  it('refuses a lane whose saved conversation is gone', async () => {
    const source = fx.lane('gone', transcript(fx.repo))
    fx.close()
    fx = await editingFixture()
    await expect(forkLane(fx.ports, source, { kind: 'fork', lineage: null })).rejects.toThrow(
      /no longer exists/,
    )
  })
})

describe('labels and jumps edit only a stopped lane’s own file', () => {
  it('labels and clears an entry in R2’s bytes, answering the label it had', async () => {
    const lines = transcript(fx.repo)
    const lane = fx.lane('source', lines)
    expect(await labelLaneEntry(fx.ports, lane, 'u1', 'mark')).toEqual({ previous: undefined })
    const label = `{"type":"label","id":"11223344","parentId":"u2","timestamp":"${NOW}","targetId":"u1","label":"mark"}\n`
    expect(readFileSync(lane.sessionFile!, 'utf8')).toBe(lines.join('') + label)
    expect(await labelLaneEntry(fx.ports, lane, 'u1', undefined)).toEqual({ previous: 'mark' })
    expect((await readLaneTree(lane)).entries.at(-1)).toMatchObject({ targetId: 'u1' })
  })

  it('jumps in R2’s bytes, answering the leaf it moved from', async () => {
    const lines = transcript(fx.repo)
    const lane = fx.lane('source', lines)
    expect(await jumpLaneTo(fx.ports, lane, 'a1')).toEqual({ previousLeaf: 'u2' })
    expect(readFileSync(lane.sessionFile!, 'utf8')).toBe(lines.join('') + jumpLine('a1', 'u2'))
  })

  it('refuses while a pi owns the file, and for an entry the lane does not have', async () => {
    const lines = transcript(fx.repo)
    const lane = fx.lane('source', lines)
    await expect(labelLaneEntry(fx.ports, lane, 'nope', 'x')).rejects.toThrow('No entry nope')
    fx.open.add(lane.sessionFile!)
    await expect(labelLaneEntry(fx.ports, lane, 'u1', 'x')).rejects.toThrow(/Stop the lane/)
    await expect(jumpLaneTo(fx.ports, lane, 'a1')).rejects.toThrow(/Stop the lane/)
    expect(readFileSync(lane.sessionFile!, 'utf8')).toBe(lines.join(''))
  })
})

describe('laneLineage', () => {
  it('puts an agent’s new lane one below the deepest lineage it is known by', () => {
    const asker = fx.lane('asker', transcript(fx.repo))
    const ref = `host:m/lane:${asker.laneId}`
    const agent = { kind: 'agent', laneRef: ref, sessionId: 's', unattended: false } as const
    expect(laneLineage({ ...agent, lineage: 0 }, fx.db)).toEqual({ createdBy: ref, lineage: 1 })
    fx.db
      .prepare(`INSERT INTO lane_prefs(lane_id, key, value) VALUES (?, 'lineage', '1')`)
      .run(asker.laneId)
    expect(laneLineage({ ...agent, lineage: 0 }, fx.db)).toEqual({ createdBy: ref, lineage: 2 })
    expect(laneLineage({ kind: 'local', clientId: 'cli', lane: ref }, fx.db)).toEqual({
      createdBy: ref,
      lineage: 2,
    })
  })

  it('records nothing for a lane the user starts', () => {
    const surface = { kind: 'surface', clientId: 'c', label: 'Mac', via: 'owner' } as const
    expect(laneLineage(surface, fx.db)).toBeNull()
    expect(laneLineage({ kind: 'local', clientId: 'cli' }, fx.db)).toBeNull()
    const machine = {
      kind: 'machine',
      machineId: 'm2',
      clientId: 'c',
      label: 'PC',
      lane: null,
    } as const
    expect(laneLineage(machine, fx.db)).toEqual({ createdBy: 'machine:m2', lineage: 1 })
  })
})
