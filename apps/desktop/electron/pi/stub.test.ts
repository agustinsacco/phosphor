import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const app = vi.hoisted(() => ({ isPackaged: false }))
vi.mock('electron', () => ({ app }))
import { claudeBinOverride, piStubPath } from './stub'

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
