// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { expect, it } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  WIDE_BROWSER_PLATFORM,
  PlatformProvider,
} from './Platform'
import { machineTraits, useHostTraits } from './machineTraits'

it('distinguishes the transport from access to the machine', () => {
  const target = { kind: 'remote' as const, hostId: MOCK_HOST_ID }
  expect(machineTraits(undefined, undefined)).toEqual({ viaHost: false, sameMachine: true })
  expect(machineTraits(target, undefined)).toEqual({ viaHost: true, sameMachine: false })
  expect(machineTraits(target, { local: true })).toEqual({ viaHost: true, sameMachine: true })
})

it('does not grant native access on either browser, even with a local projection', () => {
  useRemoteLanesStore.setState({
    hosts: { [MOCK_HOST_ID]: { ...mockRemoteHosts[MOCK_HOST_ID]!, local: true } },
  })
  function Probe() {
    return useHostTraits(MOCK_HOST_ID).sameMachine ? <button>Native</button> : null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  for (const platform of [DESKTOP_PLATFORM, WIDE_BROWSER_PLATFORM, COMPACT_PLATFORM]) {
    act(() =>
      root.render(
        <PlatformProvider value={platform}>
          <Probe />
        </PlatformProvider>,
      ),
    )
    expect(container.textContent?.includes('Native')).toBe(platform === DESKTOP_PLATFORM)
  }
  act(() => root.unmount())
})
