import { expect, expectTypeOf, it } from 'vitest'
import {
  MIN_PI_VERSION,
  piInstallLocation,
  type LiveSessionInfo,
  type SessionPush,
} from './sessions'
import * as facade from '../models'

it('sessions preserves the facade bindings and opaque live handles', () => {
  expect(piInstallLocation).toBe(facade.piInstallLocation)
  expect(MIN_PI_VERSION).toBe(facade.MIN_PI_VERSION)
  expectTypeOf<LiveSessionInfo>().toEqualTypeOf<facade.LiveSessionInfo>()
  expectTypeOf<LiveSessionInfo['sessionId']>().toEqualTypeOf<string>()
  expectTypeOf<SessionPush['kind']>().toEqualTypeOf<
    'resync' | 'event' | 'extension-ui' | 'stderr' | 'exit'
  >()
  expectTypeOf<Extract<SessionPush, { kind: 'exit' }>['code']>().toEqualTypeOf<number | null>()
})

it('piInstallLocation covers absent, empty and populated prefixes', () => {
  expect(piInstallLocation({ ok: false, minVersion: '1' })).toBeUndefined()
  expect(piInstallLocation({ ok: true, minVersion: '1', binaryPath: 'pi' })).toBe('pi')
  expect(piInstallLocation({ ok: true, minVersion: '1', binaryPath: 'node', prefixArgs: [] })).toBe(
    'node',
  )
  expect(
    piInstallLocation({
      ok: true,
      minVersion: '1',
      binaryPath: 'node',
      prefixArgs: ['pi.js', 'extra'],
    }),
  ).toBe('pi.js')
})
