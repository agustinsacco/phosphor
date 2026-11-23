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
export function fakeService(over: { features?: string[]; standby?: boolean } = {}) {
  const states = new Map<string, MigrationState>()
  let lanes: OwnerLaneRow[] = []
  let dead = false
  const calls: string[] = []
  const standby = { value: over.standby ?? true }
  const handlers: { [M in OwnerMethod]?: (p: OwnerCalls[M]['params']) => unknown } = {
    'machine.local': () => ({
      machineId: MACHINE_ID,
      hostVersion: '1.0.0',
      mode: 'local',
      features: over.features ?? ['local-mode', 'owner-socket'],
      ownerLock: {
        held: !standby.value,
        holder: standby.value ? null : 'daemon',
        pid: null,
        standby: standby.value,
      },
    }),
    'machine.owner': () => {
      throw new OwnerCallError('unsupported', 'machine.owner is not served yet.')
    },
    'owner.migrate.begin': ({ migrationId }) => {
      const staged = [...states].find(([id, s]) => s === 'staged' && id !== migrationId)
      if (staged) throw new OwnerCallError('forbidden', 'Another migration is staged.')
      if (!states.has(migrationId)) states.set(migrationId, 'staged')
      return { state: states.get(migrationId) }
    },
    'owner.migrate.import': (params) => {
      if (states.get(params.migrationId) !== 'staged')
        throw new OwnerCallError('forbidden', 'Not staged.')
      if (params.section === 'lanes')
        lanes = params.items.map((item) => ({
          laneId: item.laneId,
          sessionFile: item.sessionFile,
          sessionId: null,
          cwd: item.cwd,
          repositoryId: 'r',
        }))
      return { staged: true, replayed: false }
    },
    'owner.migrate.status': ({ migrationId }) => ({ state: states.get(migrationId) ?? 'none' }),
    'owner.migrate.commit': ({ migrationId }) => {
      if (states.get(migrationId) !== 'staged' && states.get(migrationId) !== 'committed')
        throw new OwnerCallError('forbidden', 'Not staged.')
      states.set(migrationId, 'committed')
      standby.value = false
      return { state: 'committed' }
    },
    'owner.migrate.abort': ({ migrationId }) => {
      if (states.get(migrationId) !== 'staged') return { state: 'none' }
      states.set(migrationId, 'aborted')
      lanes = []
      return { state: 'aborted' }
    },
    'owner.index': () => ({
      machineId: MACHINE_ID,
      agentDir: '/fixture/.pi/agent',
      sessionsRoot: SESSIONS,
      owning: !standby.value,
      migrateLevel: 1,
      lanes,
    }),
  }
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
    states,
    standby,
    kill: () => {
      dead = true
    },
    revive: () => {
      dead = false
    },
    committed: () => [...states.values()].filter((s) => s === 'committed').length,
    staged: () => [...states.values()].filter((s) => s === 'staged').length,
  }
}
