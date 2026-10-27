import { expect, it } from 'vitest'
import { parseClaudeAuthStatus } from './auth-status'

it('does not report a logout when Claude returns an error envelope or missing auth state', () => {
  for (const output of ['{}', '{"error":"temporary failure"}', '{"loggedIn":"true"}', '[]', 'null'])
    expect(parseClaudeAuthStatus(output).ok).toBe(false)
})
it('only authoritative booleans produce signed-in or signed-out states', () => {
  expect(parseClaudeAuthStatus('banner\n{"loggedIn":true,"email":"a@example.test"}')).toMatchObject(
    { ok: true, loggedIn: true, email: 'a@example.test' },
  )
  expect(parseClaudeAuthStatus('{"loggedIn":false}')).toMatchObject({ ok: true, loggedIn: false })
})
