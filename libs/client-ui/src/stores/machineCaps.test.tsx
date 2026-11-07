// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostConnectionView } from '@shared/ipc'
import { featureNotOffered, REMOTE_NOT_READY } from './hostRefusals'
import { LOCAL_MACHINE_CAPS, machineCaps, useMachineCaps, type MachineCaps } from './machineCaps'
import { useRemoteLanesStore } from './remoteLanes'

const host = (
  state: HostConnectionView['state'],
  edit: Partial<Pick<HostConnectionView, 'capabilities' | 'laneMarks' | 'machineShell'>> = {},
) => ({ state, capabilities: ['sessions.read', 'workspaces.read'] as const, ...edit }) as never

afterEach(() => {
  useRemoteLanesStore.setState({ hosts: {} })
  vi.unstubAllGlobals()
})

it('keeps granted apart from usable: a grant lists while offline, only a ready Host can act', () => {
  const offline = machineCaps(host('reconnecting'))
  expect(offline.ready).toBe(false)
  expect(offline.granted('sessions.read')).toBe(true)
  expect(offline.can('sessions.read')).toBe(false)
  const ready = machineCaps(host('ready'))
  expect(ready.can('sessions.read', 'workspaces.read')).toBe(true)
  expect(ready.can('sessions.read', 'terminal')).toBe(false)
  expect(ready.granted('terminal')).toBe(false)
})

it('refuses in hostRefusals words: not connected first, then the first missing grant', () => {
  expect(machineCaps(host('down')).refusal('terminal')).toBe(REMOTE_NOT_READY)
  const ready = machineCaps(host('ready'))
  expect(ready.refusal('sessions.read', 'terminal', 'routines')).toBe(featureNotOffered('terminal'))
  expect(ready.refusal('sessions.read')).toBeUndefined()
  expect(ready.refusalAs('skills.read', 'models')).toBe(featureNotOffered('skills.read', 'models'))
  expect(machineCaps(host('connecting')).refusalAs('skills.read', 'models')).toBe(REMOTE_NOT_READY)
})

it('reads lane marks and the machine shell only when the Host says true', () => {
  expect(machineCaps(host('ready'))).toMatchObject({ laneMarks: false, machineShell: false })
  expect(machineCaps(host('down', { laneMarks: true, machineShell: true }))).toMatchObject({
    laneMarks: true,
    machineShell: true,
  })
})

it('treats an unknown Host as not ready and granting nothing', () => {
  const unknown = machineCaps(undefined)
  expect(unknown).toMatchObject({ ready: false, laneMarks: false, machineShell: false })
  expect(unknown.granted('sessions.read')).toBe(false)
  expect(unknown.refusal('sessions.read')).toBe(REMOTE_NOT_READY)
})

it('gives This Mac everything', () => {
  expect(LOCAL_MACHINE_CAPS).toMatchObject({ ready: true, laneMarks: true, machineShell: true })
  expect(LOCAL_MACHINE_CAPS.can('terminal', 'routines')).toBe(true)
  expect(LOCAL_MACHINE_CAPS.granted('machine.configure')).toBe(true)
  expect(LOCAL_MACHINE_CAPS.refusal('terminal')).toBeUndefined()
})

it("useMachineCaps follows the Host's view, and is This Mac's for no Host", () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const seen: Record<string, MachineCaps> = {}
  function Probe({ hostId }: { hostId: string | undefined }): null {
    seen[hostId ?? 'local'] = useMachineCaps(hostId)
    return null
  }
  const root = createRoot(document.createElement('div'))
  useRemoteLanesStore.setState({ hosts: { h1: host('down') } })
  act(() =>
    root.render(
      <>
        <Probe hostId={undefined} />
        <Probe hostId="h1" />
      </>,
    ),
  )
  expect(seen.local).toBe(LOCAL_MACHINE_CAPS)
  expect(seen.h1!.ready).toBe(false)
  const before = seen.h1
  act(() => useRemoteLanesStore.setState({ hosts: { h1: host('ready') } }))
  expect(seen.h1!.can('sessions.read')).toBe(true)
  expect(seen.h1).not.toBe(before)
  act(() => root.unmount())
})
