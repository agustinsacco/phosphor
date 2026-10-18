import { expectTypeOf, it } from 'vitest'
import type {
  ClaudeLoginState,
  ConnectorAuthPush,
  ConnectorAuthState,
  LoginFlowState,
  LoginProviderId,
} from './auth'

it('auth keeps provider and connector login states distinct', () => {
  expectTypeOf<ClaudeLoginState['phase']>().toEqualTypeOf<
    'starting' | 'awaiting-code' | 'finishing' | 'signed-in' | 'cancelled' | 'error'
  >()
  expectTypeOf<ConnectorAuthState>().toEqualTypeOf<
    | { phase: 'starting' }
    | { phase: 'awaiting-browser'; authorizationUrl: string }
    | { phase: 'connected' }
    | { phase: 'failed'; message: string }
  >()
  expectTypeOf<ConnectorAuthPush>().toEqualTypeOf<{
    serverName: string
    state: ConnectorAuthState
  }>()
  expectTypeOf<LoginFlowState['phase']>().toEqualTypeOf<
    'starting' | 'awaiting-browser' | 'signed-in' | 'cancelled' | 'error'
  >()
  expectTypeOf<LoginFlowState['providerId']>().toEqualTypeOf<LoginProviderId>()
  expectTypeOf<Extract<LoginFlowState, { phase: 'awaiting-browser' }>>().toEqualTypeOf<{
    providerId: LoginProviderId
    phase: 'awaiting-browser'
    url: string
    userCode?: string
  }>()
})
