import type { Routine, RoutineMachine } from '@phosphor/shared/routines'
import type { createHostConnection } from '../connection'

export const ROUTINE_UNKNOWN = 'The outcome is unknown. Refresh before taking another action.'
export const UNAVAILABLE = 'Machine routines are unavailable.'
export type Connection = Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'call' | 'send'>
export interface RemoteRoutinePorts {
  connection(host: string): Connection | undefined
  hosts(): string[]
  view?(
    host: string,
  ): Pick<ReturnType<Connection['snapshot']>, 'state' | 'capabilities' | 'repositories'> | undefined
  label(host: string): string
}
export interface RemoteRoutineState {
  uncertain: Set<string>
  definitions: Map<string, Routine[]>
}
export function createRemoteRoutineState(): RemoteRoutineState {
  return { uncertain: new Set(), definitions: new Map() }
}
export const routineKey = (host: string, id: string): string => `host:${host}/${id}`

export function cacheDefinitions(
  state: RemoteRoutineState,
  host: string,
  routines: Routine[],
): void {
  if (!state.definitions.has(host) && state.definitions.size >= 32) {
    const oldest = state.definitions.keys().next().value
    if (oldest) state.definitions.delete(oldest)
  }
  state.definitions.set(host, routines)
  state.uncertain.delete(host)
}
export function clearRemoteRoutineState(state: RemoteRoutineState): void {
  state.definitions.clear()
  state.uncertain.clear()
}

export function machines(state: RemoteRoutineState, ports: RemoteRoutinePorts): RoutineMachine[] {
  const hosts = ports.hosts()
  for (const host of state.definitions.keys())
    if (!hosts.includes(host)) state.definitions.delete(host)
  for (const host of state.uncertain) if (!hosts.includes(host)) state.uncertain.delete(host)
  return hosts.flatMap((host) => {
    const view = ports.view?.(host) ?? ports.connection(host)?.snapshot()
    if (!view?.capabilities.includes('routines')) return []
    return [
      {
        id: `host:${host}`,
        label: ports.label(host),
        available: view.state === 'ready',
        control: view.capabilities.includes('sessions.control'),
        repositories: view.repositories.map(({ id, name }) => ({ id, name })),
      },
    ]
  })
}
