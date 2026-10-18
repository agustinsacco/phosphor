import { expect, it } from 'vitest'
import * as screen from './login-screen'
import * as flow from './login-flow'

it('re-exports each pure helper unchanged through the original entry', () => {
  for (const name of Object.keys(screen) as (keyof typeof screen)[]) {
    expect(flow[name]).toBe(screen[name])
  }
})

it('parses a device prompt at its new home after ANSI and CR normalization', () => {
  const text = screen.screenText('\u001b[32mhttps://example.com/device\rEnter code: ABCD-1234')
  expect(screen.classifyScreen(text)).toBe('awaiting-auth')
  expect(screen.parseAuthPrompt(text)).toEqual({
    url: 'https://example.com/device',
    userCode: 'ABCD-1234',
  })
  expect(screen.screenTail(`${text}\n\n`, 1)).toBe('Enter code: ABCD-1234')
})

it('keeps strict budget boundaries and separate browser timing', () => {
  expect(screen.expiredBudget(120_000, 0, null)).toBeNull()
  expect(screen.expiredBudget(120_001, 0, null)).toBe('setup')
  expect(screen.expiredBudget(910_000, 0, 10_000)).toBeNull()
  expect(screen.expiredBudget(910_001, 0, 10_000)).toBe('browser')
  expect(screen.timeoutMessage('setup')).toContain('login terminal')
  expect(screen.timeoutMessage('browser')).toContain('callback server')
})

it('requires a changed fingerprint only when a credential was already ready', () => {
  const ready = { status: 'ready', fingerprint: 'token' } as const
  expect(screen.isNewCredential({ status: 'not_ready' }, ready)).toBe(true)
  expect(screen.isNewCredential(ready, ready)).toBe(false)
  expect(screen.isNewCredential(ready, { ...ready, fingerprint: 'new' })).toBe(true)
  expect(screen.isNewCredential(ready, { status: 'ready' })).toBe(false)
})
