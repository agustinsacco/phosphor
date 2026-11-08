import {
  ROUTINE_LIMITS,
  parseRoutineParams,
  type RemoteRoutine,
  type RemoteRoutineRun,
} from '@phosphor/shared/host-protocol-routines'
import type { Routine, RoutineRun } from '@phosphor/shared/routines'
import type { HostFeature } from '../features/feature'
import type { HostRoutineState } from './service-state'

function remoteRoutine(state: HostRoutineState, routine: Routine): RemoteRoutine {
  const repositoryId = state.options.store
    .listRepositories()
    .find((entry) => entry.path === routine.workspacePath)?.id
  if (!repositoryId) throw new Error('repository unavailable')
  const { workspacePath: _path, attention: _attention, ...rest } = routine
  return { ...rest, repositoryId }
}

/** A run crosses the wire without its paths, session, branch or output. */
function remoteRun({
  id,
  routineId,
  status,
  scheduledAt,
  startedAt,
  endedAt,
}: RoutineRun): RemoteRoutineRun {
  return { id, routineId, status, scheduledAt, startedAt, endedAt }
}

export function createRoutineQueries(state: HostRoutineState): HostFeature {
  return {
    capability: 'routines',
    methods: ['routines.list', 'routines.history', 'routines.activity'],
    async call(method, params) {
      if (state.closing)
        return { ok: false, error: { code: 'internal', message: 'Routines stopping.' } }
      const parsed = parseRoutineParams(method, params)
      if (!parsed)
        return { ok: false, error: { code: 'bad-request', message: 'Invalid routine query.' } }
      try {
        if (method === 'routines.list')
          return { ok: true, data: state.repository.routines().map((r) => remoteRoutine(state, r)) }
        // Activity is every routine's runs; history is one routine's, which must exist.
        if (method === 'routines.history') {
          if (!parsed.routineId) throw new Error('missing id')
          state.repository.get(parsed.routineId)
        }
        return {
          ok: true,
          data: state.repository
            .history(parsed.routineId, parsed.offset, ROUTINE_LIMITS.history)
            .map(remoteRun),
        }
      } catch {
        return { ok: false, error: { code: 'internal', message: 'Routine query unavailable.' } }
      }
    },
  }
}
