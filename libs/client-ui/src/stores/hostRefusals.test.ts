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

it('refuses nothing a ready Host offers', () => {
  expect(hostFeatureRefusal(ready, 'sessions.read')).toBeUndefined()
})

it('asks for a Host update in the fixed words', () => {
  expect(needsNewerHost('pins and lane markers')).toBe(
    `A newer Host is needed for pins and lane markers. ${HOST_TOO_OLD}`,
  )
})
