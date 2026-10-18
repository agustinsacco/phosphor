import {
  ROUTINE_LIMITS,
  parseRoutineParams,
  type RemoteRoutine,
} from '@phosphor/shared/host-protocol-routines'
import type { Routine } from '@phosphor/shared/routines'
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

export function createRoutineQueries(state: HostRoutineState): HostFeature {
  return {
    capability: 'routines',
    methods: ['routines.list', 'routines.history'],
    async call(method, params) {
      if (state.closing)
        return { ok: false, error: { code: 'internal', message: 'Routines stopping.' } }
      const parsed = parseRoutineParams(method, params)
      if (!parsed)
        return { ok: false, error: { code: 'bad-request', message: 'Invalid routine query.' } }
      try {
        if (method === 'routines.list')
          return { ok: true, data: state.repository.routines().map((r) => remoteRoutine(state, r)) }
        if (!parsed.routineId) throw new Error('missing id')
        state.repository.get(parsed.routineId)
        return {
          ok: true,
          data: state.repository
            .history(parsed.routineId, parsed.offset, ROUTINE_LIMITS.history)
            .map(({ id, routineId, status, scheduledAt, startedAt, endedAt }) => ({
              id,
              routineId,
              status,
              scheduledAt,
              startedAt,
              endedAt,
            })),
        }
      } catch {
        return { ok: false, error: { code: 'internal', message: 'Routine query unavailable.' } }
      }
    },
  }
}
