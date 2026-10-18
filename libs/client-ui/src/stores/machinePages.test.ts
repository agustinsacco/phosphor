import { expect, it } from 'vitest'
import { pageMachine, useMachinePagesStore } from './machinePages'
import { useRemoteLanesStore } from './remoteLanes'
it.each(['skills', 'routines', 'artifacts'])(
  '%s follows the switcher, supports override and clears it on a later switch',
  (_page) => {
    useRemoteLanesStore.setState({ filter: 'bee1' })
    expect(pageMachine('bee1', null)).toBe('bee1')
    expect(pageMachine('bee1', 'bee2')).toBe('bee2')
    useMachinePagesStore.setState({
      skillsMachine: 'bee2',
      routinesMachine: 'host:bee2',
      artifactsMachine: 'bee2',
    })
    useRemoteLanesStore.getState().setFilter('bee3')
    const state = useMachinePagesStore.getState()
    expect(state.skillsMachine).toBeNull()
    expect(state.routinesMachine).toBe('')
    expect(state.artifactsMachine).toBe('')
    expect(pageMachine('bee3', '')).toBe('bee3')
  },
)
it('All machines means local Skills/Routines but every machine for Artifacts', () => {
  expect(pageMachine('all', null)).toBe('local')
  expect(pageMachine('all', '', true)).toBe('all')
})
