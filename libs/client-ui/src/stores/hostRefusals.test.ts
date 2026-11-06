import { expect, it } from 'vitest'
import { HOST_TOO_OLD } from '@shared/host-protocol-repositories'
import { hostFeatureRefusal, needsNewerHost, REMOTE_NOT_READY } from './hostRefusals'

const ready = { state: 'ready' as const, capabilities: ['sessions.read' as const] }

it('says a Host is not connected before anything about its features', () => {
  expect(hostFeatureRefusal(undefined, 'terminal')).toBe(REMOTE_NOT_READY)
  for (const state of ['down', 'connecting', 'reconnecting', 'signed-out'] as const)
    expect(hostFeatureRefusal({ ...ready, state }, 'sessions.read')).toBe(REMOTE_NOT_READY)
})

it('names a missing feature in words, never its capability id', () => {
  expect(hostFeatureRefusal(ready, 'terminal')).toBe(
    'This Host does not offer terminals to this device.',
  )
  expect(hostFeatureRefusal(ready, 'workspaces.read')).toBe(
    'This Host does not offer files to this device.',
  )
  expect(hostFeatureRefusal(ready, 'artifacts.read')).not.toContain('artifacts.read')
})

it('names what a model reader shows, not the skills grant behind it', () => {
  expect(hostFeatureRefusal(ready, 'skills.read', 'models')).toBe(
    'This Host does not offer models to this device.',
  )
})

it('refuses nothing a ready Host offers', () => {
  expect(hostFeatureRefusal(ready, 'sessions.read')).toBeUndefined()
})

// The three refusals a merge moves onto needsNewerHost, byte for byte.
it.each([
  // features/sessions/remoteRepositoryOrder.ts
  ['Moving folders needs', `Moving folders needs a newer Host. ${HOST_TOO_OLD}`],
  // stores/remoteLaneMarks.ts
  ['Pins and lane markers need', `Pins and lane markers need a newer Host. ${HOST_TOO_OLD}`],
  // features/machines/HostFolderBrowser.tsx
  ['Hidden folders need', `Hidden folders need a newer Host. ${HOST_TOO_OLD}`],
])('asks for a Host update as %s … does today', (subject, text) => {
  expect(needsNewerHost(subject)).toBe(text)
})
