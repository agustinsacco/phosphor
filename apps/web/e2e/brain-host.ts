import { expect } from '@playwright/test'
import { type KeyObject } from 'node:crypto'
import { createServer } from 'node:net'
import type { MachineView } from '@phosphor/shared/control-api'
import {
  BRAIN_APPROVAL,
  BRAIN_METHODS,
  BRAIN_SURFACE,
  type HostBrainMethod,
} from '@phosphor/shared/host-brain'
import { HOST_CAPABILITIES } from '@phosphor/shared/remote-host'
import { bindBrainSurface, type BrainSurfaceHandlers } from '../../host/src/api/brain-adapter'
import { createAuthority } from '../../host/src/api/authority'
import { startApi } from '../../host/src/api/server'
import { bindBrainLink } from '../../host/src/api/__fixtures__/brain-link'
import { createLaneStreams, createLanesTopic } from '../../host/src/lanes/stream'
import type { LaneSnapshot, LaneSummary } from '@phosphor/shared/host-protocol'
import {
  mockBrainData,
  mockBrainStatus,
} from '../../../libs/client-ui/src/features/brain/mockBrainData'

// The same opaque lane, memory and entity IDs deliberately occur on both Hosts.
export const OVERLAP_LANE = '11111111-1111-4111-8111-111111111111'
const HARBOR_ONLY_LANE = '22222222-2222-4222-8222-222222222222'
export const BRAIN_GENERATION = '33333333-3333-4333-8333-333333333333'
const EPOCH = '0123456789abcdef'
const repository = { id: EPOCH, name: 'Kestrel', path: '/fixture/Kestrel' }
const ok = (data: unknown) => ({ status: 'ok' as const, data })

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function graphData(label: string) {
  const { entities, details } = mockBrainData()
  const detail = details[3]!
  const memory = { ...detail.memory, summary: `${label} memory` }
  const nodes = detail.entities.map((entity) => ({ ...entity, memories: 1, connections: 1 }))
  const graph = { nodes, links: memory.links, ended: [], truncated: false, centerId: 'mara' }
  const status = mockBrainStatus()
  return { entities, detail, memory, nodes, graph, status }
}

function cardView(
  nodes: ReturnType<typeof graphData>['nodes'],
  link: ReturnType<typeof graphData>['memory']['links'][number],
  id: string,
): ReturnType<BrainSurfaceHandlers['brain:entity']> {
  const entity = nodes.find((node) => node.id === id)
  const other = nodes.find((node) => node.id !== id)
  if (!entity || !other) return { status: 'not-found' }
  return ok({
    entity,
    groups: [
      {
        predicate: 'reports_to',
        direction: 'out',
        total: 1,
        items: [{ entity: other, link: link, supports: 1 }],
        next: null,
      },
    ],
    ended: [],
    together: [],
    togetherMore: 0,
    sources: [],
    lastLearnedAt: null,
    merged: [],
    memoryCounts: { fact: 1, decision: 0, open: 0, risk: 0, procedure: 0, preference: 0 },
  })
}

/** A method the spec did not script fails loudly instead of answering for the Host. */
function unscriptedBrain() {
  return Object.fromEntries(
    (Object.keys(BRAIN_METHODS) as HostBrainMethod[]).map((method) => [
      method,
      () => {
        throw new Error(`Unscripted fixture Brain method ${method}`)
      },
    ]),
  ) as Record<HostBrainMethod, () => never>
}

function savedAgentPage(label: string) {
  return ok({
    entries: [{ id: 'same-entry', role: 'assistant', text: `${label} transcript` }],
    dialogs: [],
    controller: null,
    running: false,
    turn: null,
    messaging: false,
    next: null,
    fence: 1,
  })
}

function knowledge(label: string) {
  const { entities, detail, memory, nodes, graph, status } = graphData(label)
  let waiting: ReturnType<typeof deferred> | undefined
  let evidenceCalls = 0
  let sourceLaneId = OVERLAP_LANE
  const commands: string[] = []
  const laneReads: string[] = []
  const queued: { laneId: string; expected: unknown }[] = []
  // A guarded write names the generation it read, and the Host takes only a UUID there.
  const enabled = () => ({
    ...status,
    generation: BRAIN_GENERATION,
    prefs: { ...status.prefs, enabled: true },
    counts: { memories: 1, entities: 2 },
  })
  const handlers = {
    'brain:status': () => ok(enabled()),
    'brain:laneState': ({ args: [laneId] }) => {
      laneReads.push(laneId)
      return ok({ excluded: false, activeJob: null, lastRead: null })
    },
    'brain:queue': ({ args: [laneId], expected }, authority) => {
      if (!authority.admit()) return { status: 'unavailable' }
      queued.push({ laneId, expected })
      return ok(enabled())
    },
    'brain:overview': () => ok(graph),
    'brain:neighbourhood': () => ok(graph),
    'brain:entity': ({ args: [id] }) => cardView(nodes, memory.links[0]!, id),
    'brain:entityMemories': () => ok({ memories: [memory], entities, next: null }),
    'brain:find': () => ok({ entities: nodes, memories: [], referenced: [], degradation: [] }),
    'brain:path': () =>
      ok({
        mode: 'route',
        status: 'ok',
        from: nodes.find((node) => node.id === 'mara'),
        to: nodes.find((node) => node.id === 'tom'),
        routes: [[{ kind: 'relation', link: memory.links[0], fromId: 'mara', toId: 'tom' }]],
        entities,
        memories: [],
      }),
    'brain:tidyChanges': () => ok({ items: [], revision: status.revision }),
    'brain:laneShow': () => savedAgentPage(label),
    'brain:memory': async () => {
      evidenceCalls++
      const gate = waiting
      waiting = undefined
      await gate?.promise
      return ok({
        ...detail,
        memory,
        quotes: [{ quote: `${label} evidence`, before: '', after: '', label }],
        linkQuotes: {},
        sourceLaneId,
      })
    },
    'brain:tell': ({ args: [text] }, authority) => {
      if (!authority.admit()) return { status: 'unavailable' }
      commands.push(text)
      return ok(null)
    },
  } satisfies Partial<BrainSurfaceHandlers>
  return {
    handlers: { ...unscriptedBrain(), ...handlers } satisfies BrainSurfaceHandlers,
    commands,
    laneReads,
    queued,
    evidenceCalls: () => evidenceCalls,
    holdEvidence: () => {
      const gate = deferred()
      waiting = gate
      return gate.release
    },
    staleSource: () => {
      sourceLaneId = HARBOR_ONLY_LANE
    },
  }
}

function lanes(label: string) {
  const timestamp = new Date().toISOString()
  const makeLane = (laneId: string, title: string): LaneSummary => ({
    laneId,
    title,
    repositoryId: repository.id,
    cwd: repository.path,
    model: null,
    activity: 'stopped',
    branch: null,
    worktree: false,
    attention: 0,
    read: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    control: { fence: 1, controller: null },
  })
  const inventory = [makeLane(OVERLAP_LANE, `${label} source lane`)]
  if (label === 'Harbor') inventory.push(makeLane(HARBOR_ONLY_LANE, 'Harbor older source'))
  return {
    epoch: EPOCH,
    capabilities: HOST_CAPABILITIES,
    lanesTopic: createLanesTopic({
      epoch: EPOCH,
      list: () => ({ lanes: inventory, repositories: [repository] }),
    }),
    streams: createLaneStreams({
      epoch: EPOCH,
      snapshot(laneId) {
        const summary = inventory.find((lane) => lane.laneId === laneId)
        if (!summary) return null
        const snapshot: LaneSnapshot = {
          cursor: { epoch: EPOCH, seq: 0 },
          summary,
          state: null,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: `${label} source transcript` }],
              timestamp: Date.now(),
            },
          ],
          pending: [],
          dialogs: [],
          ui: [],
        }
        return { ok: true, snapshot }
      },
    }),
    calls: {
      call: async () => ({
        ok: false as const,
        error: { code: 'unsupported' as const, message: 'Fixture call unavailable' },
      }),
      capabilityFor: () => null,
    },
    commands: { submit: async () => {}, status: () => {} },
    controllerPresence: () => {},
  }
}

async function reservePort() {
  const reservation = createServer()
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  if (!address || typeof address === 'string') throw Error('Missing Brain fixture port')
  return address.port
}

export type BrainFixtureHost = Awaited<ReturnType<typeof startBrainFixtureHost>>

/** Actual listener and signed-grant/Brain adapters. Only the data/agent ports are scripted. */
export async function startBrainFixtureHost(
  options: {
    controlOrigin: string
    origin: string
    owner: string
    cleanups: (() => Promise<unknown>)[]
  },
  machine: MachineView,
  key: KeyObject,
) {
  if (!machine.hostVersion) throw Error('Brain fixture Host needs a version')
  const port = await reservePort()
  const data = knowledge(machine.label)
  const authority = createAuthority()
  authority.accept({ accepted: true, nextInSec: 60, ownerId: options.owner, epoch: 1 })
  const brain = bindBrainSurface(data.handlers)
  const server = startApi({
    authority,
    origin: options.controlOrigin,
    webOrigin: options.origin,
    hostId: machine.id,
    hostVersion: machine.hostVersion,
    key,
    port,
    lanes: lanes(machine.label),
    brain,
  })
  options.cleanups.push(() => server.stop())
  await expect
    .poll(() =>
      fetch(`http://127.0.0.1:${port}/v1/hello?challenge=${'a'.repeat(64)}`)
        .then((res) => res.status)
        .catch(() => 0),
    )
    .toBe(200)
  const cli = bindBrainLink('local', brain.link)
  options.cleanups.push(async () => cli.close())
  return {
    ...data,
    id: machine.id,
    port,
    async ask(message: string) {
      const args = { method: 'brain:tell', args: [message] }
      const ask = await cli.run(BRAIN_SURFACE, args, true)
      if (ask.status !== 'confirm') throw Error('Missing fixture Brain approval')
      const confirm = { confirmId: ask.confirmId, digest: ask.digest }
      return {
        status: () => cli.run(BRAIN_APPROVAL, { action: 'status', id: confirm.confirmId }),
        redeem: () => cli.run(BRAIN_SURFACE, args, true, { confirm }),
      }
    },
  }
}
