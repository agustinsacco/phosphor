import { afterEach, expect, it } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import {
  clearBrowserMemory,
  laneListFor,
  rememberLocation,
  scopedMachine,
  useBrowserMemory,
} from './browserMemory'

afterEach(clearBrowserMemory)

const machines = [{ id: 'down-host' }, { id: MOCK_HOST_ID }]
const hosts = { [MOCK_HOST_ID]: mockRemoteHosts[MOCK_HOST_ID]! }

it('scopes to the machine in view, else the last one looked at, else the first that can start', () => {
  expect(scopedMachine(MOCK_HOST_ID, 'down-host', machines, hosts)).toBe(MOCK_HOST_ID)
  expect(scopedMachine(undefined, 'down-host', machines, hosts)).toBe('down-host')
  expect(scopedMachine(undefined, undefined, machines, hosts)).toBe(MOCK_HOST_ID)
  // A machine no longer in the account is not a scope.
  expect(scopedMachine('gone', 'gone', machines, hosts)).toBe(MOCK_HOST_ID)
  expect(scopedMachine(undefined, undefined, [{ id: 'down-host' }], {})).toBe('down-host')
  expect(scopedMachine(undefined, undefined, [], {})).toBeUndefined()
})

it('remembers the lane list, the machine and the Library page a location shows', () => {
  rememberLocation({ to: 'lanes', machine: 'a' })
  rememberLocation({ to: 'page', page: 'routines', machine: 'b' })
  rememberLocation({ to: 'page', page: 'machines' })
  expect(useBrowserMemory.getState()).toEqual({
    lanes: { to: 'lanes', machine: 'a' },
    lastMachine: 'b',
    library: 'routines',
  })
})

it("a lane's Back returns to the list it came from only if that list shows the lane", () => {
  expect(laneListFor('a')).toEqual({ to: 'lanes', machine: 'a' })
  rememberLocation({ to: 'lanes' })
  expect(laneListFor('a')).toEqual({ to: 'lanes' })
  rememberLocation({ to: 'lanes', machine: 'b' })
  expect(laneListFor('a')).toEqual({ to: 'lanes', machine: 'a' })
  expect(laneListFor('b')).toEqual({ to: 'lanes', machine: 'b' })
})
