import { describe, expect, expectTypeOf, it } from 'vitest'
import * as facade from '../control-api'
import type { GrantClient } from '../host-grant'
import {
  ARCHES,
  PLATFORMS,
  type Arch,
  type ClientRegisterResponse,
  type EnrollmentPollResponse,
  type GrantIssueResponse,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type HostRevocations,
  type HostSelfResponse,
  type MachineView,
  type MachineState,
  type Platform,
  type Readiness,
} from './types'

type NullableKeys<T> = { [K in keyof T]-?: null extends T[K] ? K : never }[keyof T]
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T]

describe('control wire types', () => {
  it('derives the platform and architecture unions from their runtime lists', () => {
    expect(PLATFORMS).toEqual(['linux', 'darwin', 'win32'])
    expect(ARCHES).toEqual(['x64', 'arm64'])
    expectTypeOf<(typeof PLATFORMS)[number]>().toEqualTypeOf<Platform>()
    expectTypeOf<(typeof ARCHES)[number]>().toEqualTypeOf<Arch>()
    expect(facade.PLATFORMS).toBe(PLATFORMS)
    expect(facade.ARCHES).toBe(ARCHES)
  })

  it('keeps the readiness, state and poll unions', () => {
    expectTypeOf<Readiness['pi']>().toEqualTypeOf<'ok' | 'missing' | 'outdated' | 'unknown'>()
    expectTypeOf<Readiness['claude']>().toEqualTypeOf<'ok' | 'missing' | 'signed-out' | 'unknown'>()
    expectTypeOf<Readiness['tailscale']>().toEqualTypeOf<
      'ok' | 'missing' | 'stopped' | 'no-https' | 'unknown'
    >()
    expectTypeOf<MachineState>().toEqualTypeOf<'running' | 'stopping'>()
    expectTypeOf<EnrollmentPollResponse['status']>().toEqualTypeOf<
      'pending' | 'approved' | 'expired'
    >()
    expectTypeOf<keyof Extract<EnrollmentPollResponse, { status: 'approved' }>>().toEqualTypeOf<
      'status' | 'hostId' | 'label' | 'owner'
    >()
  })

  it('marks exactly the fields a peer may send as null', () => {
    expectTypeOf<NullableKeys<MachineView>>().toEqualTypeOf<
      'hostVersion' | 'lastSeenAt' | 'state' | 'readiness' | 'lanes' | 'endpoint'
    >()
    expectTypeOf<NullableKeys<HostSelfResponse>>().toEqualTypeOf<'lastSeenAt'>()
    expectTypeOf<NullableKeys<HeartbeatRequest>>().toEqualTypeOf<'endpoint'>()
    expectTypeOf<NullableKeys<GrantIssueResponse['host']>>().toEqualTypeOf<'endpoint'>()
  })

  it('marks only the heartbeat revocation metadata as omissible', () => {
    expectTypeOf<OptionalKeys<HeartbeatResponse>>().toEqualTypeOf<'epoch' | 'ownerId' | 'revoked'>()
    expectTypeOf<OptionalKeys<MachineView>>().toEqualTypeOf<never>()
    expectTypeOf<NonNullable<HeartbeatResponse['revoked']>>().toEqualTypeOf<
      HostRevocations['revoked']
    >()
    expectTypeOf<ClientRegisterResponse['client']>().toEqualTypeOf<GrantClient>()
  })
})
