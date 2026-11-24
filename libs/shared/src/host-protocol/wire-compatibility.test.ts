import { expect, it } from 'vitest'
import { HOST_CAPABILITIES, LEGACY_HOST_CAPABILITIES } from '../remote-host'
import { HOST_FRAMES } from '../../test/__fixtures__/protocol-freeze'
import { HOST_LIMITS } from './constants'
import type { HostFrame } from './frames'

const guidance = 'Protocol v1 readers refuse new names. See docs/remote-protocol.md.'
const v1GrantCaps = [
  'sessions.read',
  'sessions.control',
  'workspaces.read',
  'workspaces.write',
  'artifacts.read',
  'skills.read',
  'terminal',
  'routines',
] as const
const v1HelloCaps = [...v1GrantCaps, 'machine.configure'] as const
const v1HostFrames = [
  'attention',
  'auth-renewed',
  'error',
  'event',
  'lanes',
  'lanes-delta',
  'pong',
  'ready',
  'receipt',
  'result',
  'routines-changed',
  'snapshot',
  'subscribe-failed',
  'terminal.ack',
  'terminal.exit',
  'terminal.output',
  'terminal.reset',
] as const

it('keeps the grant issuer on its frozen v1 list, independent of the hello vocabulary', () => {
  // The Control route tests compare the decoded signed grant to this production list.
  expect(LEGACY_HOST_CAPABILITIES, guidance).toEqual(v1GrantCaps)
  expect(Object.isFrozen(LEGACY_HOST_CAPABILITIES), guidance).toBe(true)
})

it('keeps every capability available to hello and ready within the v1 vocabulary', () => {
  for (const cap of HOST_CAPABILITIES) expect(v1HelloCaps, guidance).toContain(cap)
})

it('keeps all outbound Host frame types readable by v1 clients', () => {
  // Frame types are erased. The parser fixtures exhaust the union at compile time;
  // also point at the contract if a new type has not even acquired a fixture yet.
  const reviewed: Exclude<HostFrame['type'], (typeof v1HostFrames)[number]> extends never
    ? true
    : typeof guidance = true
  expect(reviewed).toBe(true)
  expect(Object.keys(HOST_FRAMES).sort(), guidance).toEqual(v1HostFrames)
})

it('keeps lanes topics within the repository and lane bounds old clients accept', () => {
  expect(HOST_LIMITS.repositoriesPerHost, guidance).toBe(64)
  expect(HOST_LIMITS.lanesPerHost, guidance).toBe(1000)
})
