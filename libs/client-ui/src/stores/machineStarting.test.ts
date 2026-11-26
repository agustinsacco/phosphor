import { afterEach, describe, expect, it } from 'vitest'
import { hostLaneSession, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { machineCaps } from './machineCaps'
import { canControlSession, readOnlyLane, useRemoteLanesStore } from './remoteLanes'
import { useSessionsStore } from './sessions'

/*
 * A local service accepts the socket before its lanes start, `ready` with no
 * capabilities, then reconnects with them. Until then the machine is starting:
 * nothing is usable, and its lanes are waiting, not read-only.
 */
afterEach(() => {
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
})

function connect(capabilities: 'none' | 'granted') {
  const { hosts, live } = hostLaneSession({ self: true })
  const host = hosts[MOCK_HOST_ID]!
  if (capabilities === 'none') host.capabilities = []
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live })
  return host
}

describe('a ready connection that grants nothing yet', () => {
  it('is not ready, and its held lane neither sends nor reads as read-only', () => {
    const host = connect('none')
    expect(machineCaps(host).ready).toBe(false)
    expect(canControlSession(mockRemoteInfo.sessionId)).toBe(false)
    expect(readOnlyLane(mockRemoteInfo.sessionId)).toBe(false)
  })

  it('becomes usable once the Host grants its capabilities', () => {
    const host = connect('granted')
    expect(machineCaps(host).ready).toBe(true)
    expect(canControlSession(mockRemoteInfo.sessionId)).toBe(true)
    expect(readOnlyLane(mockRemoteInfo.sessionId)).toBe(false)
  })
})
