import {
  nextOccurrences,
  validateRoutine,
  type Routine,
  type RoutineRun,
  type RoutinesSnapshot,
} from '@shared/routines'

const snapshot: RoutinesSnapshot = { routines: [], runs: [], background: false, error: null }
const listeners = new Set<() => void>()
export function onMockRoutinesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Browser-only simulation. Never creates processes or external side effects. */
export async function mockRoutineCall(channel: string, args: unknown[]): Promise<unknown> {
  const routine = (): Routine => {
    const value = snapshot.routines.find((r) => r.id === args[0])
    if (!value) throw new Error('Routine not found.')
    return value
  }
  let result: unknown
  switch (channel) {
    case 'routines:list':
      return structuredClone(snapshot)
    case 'routines:check': {
      const input = validateRoutine(args[0])
      return {
        summary: 'Browser mock: setup checks are simulated. No model will run.',
        warning: input.isolated
          ? null
          : 'Browser mock: a folder task is checked against live sessions and, for code intent, uncommitted changes.',
      }
    }
    case 'routines:laneIndex':
      return Object.fromEntries(
        snapshot.runs
          .filter((r) => r.sessionPath && !r.promoted)
          .map((r) => [r.sessionPath!, { routineId: r.routineId, runId: r.id }]),
      )
    case 'routines:promoteRun': {
      const run = snapshot.runs.find((r) => r.id === args[0])
      if (!run) throw new Error('Run not found.')
      run.promoted = true
      break
    }
    case 'routines:history':
      return structuredClone(
        snapshot.runs
          .filter((r) => r.routineId === args[0])
          .slice(Number(args[1]), Number(args[1]) + 50),
      )
    case 'routines:save': {
      const input = validateRoutine(args[0])
      const old = snapshot.routines.find((r) => r.id === args[1])
      if (old && old.revision !== args[2]) throw new Error('Routine changed; reopen editor.')
      const r: Routine = {
        ...input,
        id: old?.id ?? crypto.randomUUID(),
        createdAt: old?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        revision: (old?.revision ?? 0) + 1,
        attention: null,
        archived: false,
        nextAt: input.enabled
          ? (nextOccurrences(input.schedule, input.timezone, Date.now(), 1)[0] ?? null)
          : null,
      }
      snapshot.routines = [...snapshot.routines.filter((x) => x.id !== r.id), r]
      break
    }
    case 'routines:background':
      snapshot.background = args[0] === true
      break
    case 'routines:pauseAll':
      snapshot.routines = snapshot.routines.map((r) => ({
        ...r,
        enabled: false,
        nextAt: null,
        revision: r.revision + 1,
      }))
      break
    case 'routines:archive':
      Object.assign(routine(), { archived: true, enabled: false, nextAt: null })
      break
    case 'routines:delete':
      routine()
      snapshot.routines = snapshot.routines.filter((r) => r.id !== args[0])
      snapshot.runs = snapshot.runs.filter((r) => r.routineId !== args[0])
      break
    case 'routines:skipNext': {
      const r = routine()
      r.nextAt = nextOccurrences(r.schedule, r.timezone, r.nextAt ?? Date.now(), 1)[0] ?? null
      break
    }
    case 'routines:cancel':
      break
    case 'routines:run': {
      const r = routine()
      if (!r.trusted) throw new Error('Acknowledge unattended access first.')
      const run: RoutineRun = {
        id: crypto.randomUUID(),
        routineId: r.id,
        trigger: 'manual',
        createdAt: Date.now(),
        scheduledAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
        status: 'finished',
        reason: 'Simulated browser run. No model or external actions executed.',
        definition: structuredClone(r),
        sessionId: null,
        sessionPath: null,
        workspacePath: r.workspacePath,
        branch: null,
        baseCommit: null,
        accountId: null,
        summary: 'This is a mock routine result for UI review.',
      }
      snapshot.runs.unshift(run)
      result = run
      break
    }
    default:
      throw new Error(`Unsupported mock routine command: ${channel}`)
  }
  for (const listener of listeners) listener()
  return structuredClone(result)
}
