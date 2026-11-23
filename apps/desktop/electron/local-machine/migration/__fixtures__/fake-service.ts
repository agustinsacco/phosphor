import { OwnerCallError } from '@phosphor/host-client/owner'
import type {
  MigrationState,
  OwnerCalls,
  OwnerLaneRow,
  OwnerMethod,
} from '@phosphor/shared/host-protocol-owner'
import type { OwnerChannel } from '../owner-channel'
import { MACHINE_ID, SESSIONS } from './plan-facts'

/**
 * An in-memory Phosphor service for the runner and gate tests: P4a's
 * migration states (one staged id at a time, abort restores, commit is
 * durable), the lanes import feeding `owner.index`, and `machine.local`.
 * `kill()` makes every later call fail, as a crashed Desktop would see.
 */
interface ServiceState {
  readonly states: Map<string, MigrationState>
  lanes: OwnerLaneRow[]
  /** Lanes an earlier, committed migration left: an import keeps their ids, an abort keeps them. */
  kept: OwnerLaneRow[]
  readonly standby: { value: boolean }
  readonly features: string[]
}

type Handlers = { [M in OwnerMethod]?: (p: OwnerCalls[M]['params']) => unknown }

function migrateHandlers(s: ServiceState): Handlers {
  return {
    'owner.migrate.begin': ({ migrationId }) => {
      const staged = [...s.states].find(([id, st]) => st === 'staged' && id !== migrationId)
      if (staged) throw new OwnerCallError('forbidden', 'Another migration is staged.')
      if (!s.states.has(migrationId)) s.states.set(migrationId, 'staged')
      return { state: s.states.get(migrationId) }
    },
    'owner.migrate.import': (params) => {
      if (s.states.get(params.migrationId) !== 'staged')
        throw new OwnerCallError('forbidden', 'Not staged.')
      if (params.section === 'lanes')
        s.lanes = params.items.map(
          (item) =>
            s.kept.find((row) => row.sessionFile === item.sessionFile) ?? {
              laneId: item.laneId,
              sessionFile: item.sessionFile,
              sessionId: null,
              cwd: item.cwd,
              repositoryId: 'r',
            },
        )
      return { staged: true, replayed: false }
    },
    'owner.migrate.status': ({ migrationId }) => ({ state: s.states.get(migrationId) ?? 'none' }),
    'owner.migrate.commit': ({ migrationId }) => {
      const state = s.states.get(migrationId)
      if (state !== 'staged' && state !== 'committed')
        throw new OwnerCallError('forbidden', 'Not staged.')
      s.states.set(migrationId, 'committed')
      s.standby.value = false
      return { state: 'committed' }
    },
    'owner.migrate.abort': ({ migrationId }) => {
      if (s.states.get(migrationId) !== 'staged') return { state: 'none' }
      s.states.set(migrationId, 'aborted')
      s.lanes = [...s.kept]
      return { state: 'aborted' }
    },
  }
}

function machineHandlers(s: ServiceState): Handlers {
  return {
    'machine.local': () => ({
      machineId: MACHINE_ID,
      hostVersion: '1.0.0',
      mode: 'local',
      features: s.features,
      ownerLock: {
        held: !s.standby.value,
        holder: s.standby.value ? null : 'daemon',
        pid: null,
        standby: s.standby.value,
      },
    }),
    'machine.owner': () => {
      throw new OwnerCallError('unsupported', 'machine.owner is not served yet.')
    },
    'owner.index': () => ({
      machineId: MACHINE_ID,
      agentDir: '/fixture/.pi/agent',
      sessionsRoot: SESSIONS,
      owning: !s.standby.value,
      migrateLevel: 1,
      lanes: s.lanes,
    }),
  }
}

export function fakeService(over: { features?: string[]; standby?: boolean } = {}) {
  const s: ServiceState = {
    states: new Map(),
    lanes: [],
    kept: [],
    standby: { value: over.standby ?? true },
    features: over.features ?? ['local-mode', 'owner-socket'],
  }
  const handlers: Handlers = { ...machineHandlers(s), ...migrateHandlers(s) }
  let dead = false
  const calls: string[] = []
  const channel: OwnerChannel = {
    machineId: MACHINE_ID,
    async call(method, params) {
      if (dead) throw new Error('offline')
      calls.push(method)
      const handler = handlers[method] as ((p: unknown) => unknown) | undefined
      if (!handler) throw new OwnerCallError('unsupported', `${method} is not served.`)
      return handler(params) as never
    },
    close: () => {},
  }
  return {
    channel,
    calls,
    states: s.states,
    standby: s.standby,
    kill: () => {
      dead = true
    },
    revive: () => {
      dead = false
    },
    /** The service already has these lanes, as after a break-glass restore. */
    keep(rows: OwnerLaneRow[]) {
      s.kept = rows
      s.lanes = [...rows]
    },
    committed: () => [...s.states.values()].filter((st) => st === 'committed').length,
    staged: () => [...s.states.values()].filter((st) => st === 'staged').length,
  }
}
