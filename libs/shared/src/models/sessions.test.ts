import { expect, expectTypeOf, it } from 'vitest'
import { MIN_PI_VERSION, type LiveSessionInfo, type SessionPush } from './sessions'
import * as facade from '../models'

it('sessions preserves the facade bindings and opaque live handles', () => {
  expect(MIN_PI_VERSION).toBe(facade.MIN_PI_VERSION)
  expectTypeOf<LiveSessionInfo>().toEqualTypeOf<facade.LiveSessionInfo>()
  expectTypeOf<LiveSessionInfo['sessionId']>().toEqualTypeOf<string>()
  expectTypeOf<SessionPush['kind']>().toEqualTypeOf<
    'resync' | 'event' | 'extension-ui' | 'stderr' | 'exit'
  >()
  expectTypeOf<Extract<SessionPush, { kind: 'exit' }>['code']>().toEqualTypeOf<number | null>()
})
