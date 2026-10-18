import { expect, it } from 'vitest'
import {
  cacheDefinitions,
  clearRemoteRoutineState,
  createRemoteRoutineState,
  machines,
  routineKey,
  type RemoteRoutinePorts,
} from './state'

it('bounds definitions to 32 hosts and evicts the oldest insertion, not the latest refresh', () => {
  const state = createRemoteRoutineState()
  for (let i = 0; i < 32; i++) cacheDefinitions(state, `host-${i}`, [])
  cacheDefinitions(state, 'host-0', [])
  expect(state.definitions.size).toBe(32)
  cacheDefinitions(state, 'host-32', [])
  expect(state.definitions.size).toBe(32)
  expect(state.definitions.has('host-0')).toBe(false)
  expect(state.definitions.has('host-1')).toBe(true)
})

it('clears uncertainty only for the successfully cached host and clears all state explicitly', () => {
  const state = createRemoteRoutineState()
  state.uncertain.add('one').add('two')
  cacheDefinitions(state, 'one', [])
  expect([...state.uncertain]).toEqual(['two'])
  clearRemoteRoutineState(state)
  expect(state.uncertain.size).toBe(0)
  expect(state.definitions.size).toBe(0)
})

it('prunes removed hosts while projecting cached machine views with only repository labels', () => {
  const state = createRemoteRoutineState()
  cacheDefinitions(state, 'removed', [])
  cacheDefinitions(state, 'kept', [])
  state.uncertain.add('removed').add('kept')
  const ports: RemoteRoutinePorts = {
    connection: () => undefined,
    hosts: () => ['kept', 'unsupported'],
    label: (host) => `Label ${host}`,
    view: (host) => ({
      state: 'reconnecting',
      capabilities: host === 'kept' ? ['routines', 'sessions.control'] : [],
      repositories: [{ id: 'repo', name: 'Repo label', path: '/private/host' }],
    }),
  }
  expect(machines(state, ports)).toEqual([
    {
      id: 'host:kept',
      label: 'Label kept',
      available: false,
      control: true,
      repositories: [{ id: 'repo', name: 'Repo label' }],
    },
  ])
  expect([...state.definitions.keys()]).toEqual(['kept'])
  expect([...state.uncertain]).toEqual(['kept'])
  expect(routineKey('kept', 'routine')).toBe('host:kept/routine')
})
