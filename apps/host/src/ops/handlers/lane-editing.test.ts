import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { AuditEntry, UndoRecord } from '@phosphor/session-runtime/ops/audit'
import type { OpPrincipal } from '@phosphor/session-runtime/ops/types'
import {
  editingFixture,
  line,
  transcript,
  type EditingFixture,
} from '../../lanes/__fixtures__/editing'
import { createOpsService, type OpsService } from '../service'
import { daemonUndoIsCurrent, type DaemonHandlerDeps } from './index'

const MACHINE = '33333333-3333-4333-8333-333333333333'
const surface = {
  kind: 'surface',
  clientId: 'owner',
  label: 'Desktop',
  via: 'owner',
  caps: ['sessions.read', 'sessions.control', 'workspaces.write', 'machine.configure'],
} as const
const cli: OpPrincipal = { kind: 'local', clientId: 'cli' }

let fx: EditingFixture
let service: OpsService
const live = new Map<string, string>()

beforeEach(async () => {
  live.clear()
  fx = await editingFixture()
  service = await createOpsService({
    stateDirectory: fx.stateDirectory,
    uid: process.getuid?.(),
    selfIds: () => [MACHINE],
    enrolledId: () => MACHINE,
    store: fx.store,
    lanes: {} as never,
    shellEnvironment: null,
    editing: {
      runtime: fx.ports.runtime,
      announce: fx.ports.announce,
      sessionsRoot: fx.ports.sessionsRoot,
    },
    daemonLanes: {
      list: () => fx.store.listLanes(),
      summary: (id) => fx.store.getLane(id),
      sessionFor: (id) => live.get(id) ?? null,
    },
    command: async () => ({ success: true }),
    unattended: () => false,
    log: () => {},
  })
})
afterEach(() => {
  service.close()
  fx.close()
})

const refOf = (laneId: string) => `host:${MACHINE}/lane:${laneId}`
type Args = Readonly<Record<string, unknown>>
const run = (principal: OpPrincipal, op: string, args: Args, page?: string) =>
  service.dispatcher.run(principal, { op, args, ...(page !== undefined ? { page } : {}) })

/** An asked op, approved by the user, then resubmitted with its confirmation. */
async function approved(principal: OpPrincipal, op: string, args: Args) {
  const asked = await run(principal, op, args)
  if (asked.status !== 'confirm') return asked
  ok(await run(surface, 'confirm.approve', { confirmId: asked.confirmId }))
  const confirm = { confirmId: asked.confirmId, digest: asked.digest }
  return service.dispatcher.run(principal, { op, args, confirm })
}

function ok(result: OpsRunResult) {
  if (result.status !== 'ok') throw new Error(`${result.status}: ${JSON.stringify(result)}`)
  return result
}

/** The Undo precondition the service consults, for an audited change of `op`. */
function isCurrent(op: string, record: UndoRecord) {
  const deps = { store: fx.store, db: fx.db } as unknown as DaemonHandlerDeps
  return daemonUndoIsCurrent(
    { op, undoRecord: record } as AuditEntry & { undoRecord: UndoRecord },
    deps,
  )
}

it('announces laneEditing: every editing op has a daemon handler', () => {
  expect(service.readyFlags.has('laneEditing')).toBe(true)
})

it('reads a lane’s tree in pages, live or not', async () => {
  const at = '2026-08-01T10:00:00.000Z'
  const rows = Array.from({ length: 300 }, (_, i) =>
    line({
      type: 'label',
      id: `e${i}`,
      parentId: i ? `e${i - 1}` : null,
      timestamp: at,
      targetId: 'e0',
      label: 'x'.repeat(150),
    }),
  )
  const lane = fx.lane('big', [transcript(fx.repo)[0]!, ...rows])
  live.set(lane.laneId, 'session-1')

  const first = ok(await run(surface, 'lane.tree', { ref: refOf(lane.laneId) }))
  const data = first.data as { sessionId: string; leafId: string; entries: { id: string }[] }
  expect(data).toMatchObject({ sessionId: '11111111-1111-4111-8111-111111111111', leafId: 'e299' })
  expect(data.entries[0]).toMatchObject({ id: 'e0', type: 'label', label: 'x'.repeat(150) })
  expect(first.next).toBe(String(data.entries.length))

  const second = ok(await run(surface, 'lane.tree', { ref: refOf(lane.laneId) }, first.next))
  expect((second.data as { entries: { id: string }[] }).entries[0]?.id).toBe(
    `e${data.entries.length}`,
  )
})

it('refuses to label or jump an open lane, and leaves its file alone', async () => {
  const lane = fx.lane('open', transcript(fx.repo))
  live.set(lane.laneId, 'session-1')
  const before = readFileSync(lane.sessionFile!, 'utf8')
  for (const [op, args] of [
    ['lane.label', { ref: refOf(lane.laneId), entry: 'u1', label: 'x' }],
    ['lane.jump', { ref: refOf(lane.laneId), entry: 'a1' }],
  ] as const) {
    expect(await run(surface, op, args)).toMatchObject({
      status: 'denied',
      code: 'unavailable',
      text: expect.stringContaining('Stop it before changing its saved conversation'),
    })
  }
  expect(readFileSync(lane.sessionFile!, 'utf8')).toBe(before)
})

it('forks and rewinds into a new lane the result names, and refuses a bad entry', async () => {
  const lane = fx.lane('source', transcript(fx.repo))
  const forked = ok(await run(surface, 'lane.fork', { ref: refOf(lane.laneId), at: 'a1' }))
  const { lane: forkRef } = forked.data as { lane: string }
  expect(forkRef).toMatch(new RegExp(`^host:${MACHINE}/lane:`))
  expect(forked.next).toBe(`lane.resume ${forkRef}`)
  expect(fx.store.getLane(forkRef.split('lane:')[1]!)?.removedAt).toBeNull()

  const rewound = ok(await run(surface, 'lane.rewind', { ref: refOf(lane.laneId), entry: 'u2' }))
  expect(rewound.data).toMatchObject({ prefill: 'second' })

  expect(await run(surface, 'lane.rewind', { ref: refOf(lane.laneId), entry: 'a1' })).toMatchObject(
    {
      status: 'denied',
      code: 'bad-request',
    },
  )
  expect(fx.store.getLane(lane.laneId)?.sessionFile).toBe(lane.sessionFile)
})

it('undoes a label while it is current, and refuses once it changed again', async () => {
  const lane = fx.lane('source', transcript(fx.repo))
  const ref = refOf(lane.laneId)
  const labeled = ok(await run(cli, 'lane.label', { ref, entry: 'u1', label: 'mark' }))
  expect(labeled.undo).toBe(true)
  const undone = ok(await run(surface, 'audit.undo', { auditId: labeled.auditId }))
  expect(undone.text).toMatch(/Cleared the label on entry u1/)

  const again = ok(await run(cli, 'lane.label', { ref, entry: 'u1', label: 'one' }))
  ok(await run(cli, 'lane.label', { ref, entry: 'u1', label: 'two' }))
  expect(await run(surface, 'audit.undo', { auditId: again.auditId })).toMatchObject({
    status: 'denied',
    code: 'unavailable',
  })
})

it('undoes a jump while the lane still continues from it', async () => {
  const lane = fx.lane('source', transcript(fx.repo))
  const ref = refOf(lane.laneId)
  const jumped = ok(await approved(cli, 'lane.jump', { ref, entry: 'a1' }))
  expect(jumped.undo).toBe(true)
  ok(await run(surface, 'audit.undo', { auditId: jumped.auditId }))
  const tree = ok(await run(surface, 'lane.tree', { ref })).data as {
    entries: { type: string; parentId: string | null }[]
  }
  expect(tree.entries.at(-1)).toMatchObject({ type: 'branch_summary', parentId: 'u2' })
  // The undo was itself a jump away from a1, so the first jump is no longer current.
  expect(await run(surface, 'audit.undo', { auditId: jumped.auditId })).toMatchObject({
    status: 'denied',
  })
})

it('counts an Undo as current only with the change’s own args, for label and jump', async () => {
  const lane = fx.lane('source', transcript(fx.repo))
  const ref = refOf(lane.laneId)
  ok(await run(cli, 'lane.label', { ref, entry: 'u1', label: 'mark' }))
  const inverse = { op: 'lane.label', args: { ref, entry: 'u1' } }
  expect(
    await isCurrent('lane.label', { inverse, forward: { ref, entry: 'u1', label: 'mark' } }),
  ).toBe(true)
  expect(await isCurrent('lane.label', { inverse })).toBe(false)
  const jumpInverse = { op: 'lane.jump', args: { ref, entry: 'u2' } }
  expect(await isCurrent('lane.jump', { inverse: jumpInverse })).toBe(false)
  expect(await isCurrent('lane.unknown', { inverse })).toBe(false)
})

it('counts a fork’s or clone’s Undo as current while its new lane is still there', async () => {
  const lane = fx.lane('source', transcript(fx.repo))
  const forked = ok(await run(cli, 'lane.clone', { ref: refOf(lane.laneId) }))
  const { lane: newRef } = forked.data as { lane: string }
  const record = { inverse: { op: 'lane.archive', args: { ref: newRef } } }
  expect(forked.undo).toBe(true)
  expect(await isCurrent('lane.clone', record)).toBe(true)
  expect(await isCurrent('lane.fork', record)).toBe(true)
  fx.store.markRemoved(newRef.split('lane:')[1]!)
  expect(await isCurrent('lane.clone', record)).toBe(false)
})

it('offers no Undo for a rewind', async () => {
  const lane = fx.lane('source', transcript(fx.repo))
  const rewound = ok(await approved(cli, 'lane.rewind', { ref: refOf(lane.laneId), entry: 'u2' }))
  expect(rewound.undo).toBeUndefined()
})
