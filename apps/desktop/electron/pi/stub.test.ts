import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const app = vi.hoisted(() => ({ isPackaged: false }))
vi.mock('electron', () => ({ app }))
import { claudeBinOverride, piStubPath, stubBrainEnabled, stubOpsEnabled } from './stub'

beforeEach(() => {
  app.isPackaged = false
})
afterEach(() => vi.unstubAllEnvs())

describe.each([
  { name: 'piStubPath', gate: piStubPath, env: 'PHOSPHOR_PI_STUB' },
  { name: 'claudeBinOverride', gate: claudeBinOverride, env: 'PHOSPHOR_CLAUDE_BIN' },
])('$name', ({ gate, env }) => {
  it.each([undefined, '', '/test/executable', ' '])(
    'ignores environment value %s in packaged builds',
    (value) => {
      app.isPackaged = true
      vi.stubEnv(env, value)
      expect(gate()).toBeUndefined()
    },
  )

  it.each([
    { value: undefined, expected: undefined },
    { value: '', expected: undefined },
    { value: '/test/executable', expected: '/test/executable' },
    { value: ' ', expected: ' ' },
  ])('preserves unpackaged environment handling for $value', ({ value, expected }) => {
    vi.stubEnv(env, value)
    expect(gate()).toBe(expected)
  })

  it('reads environment and packaging on every call', () => {
    vi.stubEnv(env, '/test/first')
    expect(gate()).toBe('/test/first')
    vi.stubEnv(env, '/test/second')
    expect(gate()).toBe('/test/second')
    app.isPackaged = true
    expect(gate()).toBeUndefined()
    app.isPackaged = false
    vi.stubEnv(env, undefined)
    expect(gate()).toBeUndefined()
  })
})

it('opts into stub ops only in an unpackaged, redirected test run', () => {
  vi.stubEnv('PHOSPHOR_PI_STUB', '/test/stub.cjs')
  vi.stubEnv('PHOSPHOR_TEST_USER_DATA', '/test/profile')
  vi.stubEnv('PHOSPHOR_E2E_OPS', '1')
  expect(stubOpsEnabled()).toBe(true)
  app.isPackaged = true
  expect(stubOpsEnabled()).toBe(false)
  app.isPackaged = false
  for (const key of ['PHOSPHOR_PI_STUB', 'PHOSPHOR_TEST_USER_DATA', 'PHOSPHOR_E2E_OPS']) {
    const value = process.env[key]
    vi.stubEnv(key, undefined)
    expect(stubOpsEnabled()).toBe(false)
    vi.stubEnv(key, value)
  }
})

it('gives pi stub lanes Brain only in an unpackaged Brain test run', () => {
  vi.stubEnv('PHOSPHOR_BRAIN_TEST_EMBEDDINGS', '1')
  expect(stubBrainEnabled()).toBe(true)
  app.isPackaged = true
  expect(stubBrainEnabled()).toBe(false)
  app.isPackaged = false
  vi.stubEnv('PHOSPHOR_BRAIN_TEST_EMBEDDINGS', undefined)
  expect(stubBrainEnabled()).toBe(false)
})
