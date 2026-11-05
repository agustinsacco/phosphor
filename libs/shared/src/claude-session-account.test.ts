import { expect, it } from 'vitest'
import { claudeSessionAccount } from './claude-session-account'

const NOW = 1_700_000_000_000
const accounts = [
  { id: 'a', label: 'a', email: 'a@example.test', plan: 'max' },
  { id: 'b', label: 'b', email: 'b@example.test' },
  { id: 'c', label: 'c' },
]
const holds: Record<string, number> = { a: NOW + 60_000, b: NOW + 1, c: NOW - 1 }

it('describes the account with its live hold and the first other account not on hold', () => {
  expect(claudeSessionAccount(accounts, 'a', 'ordered', (id) => holds[id], NOW)).toEqual({
    id: 'a',
    label: 'a',
    email: 'a@example.test',
    plan: 'max',
    total: 3,
    mode: 'ordered',
    cooldownUntil: NOW + 60_000,
    alternative: { id: 'c', label: 'c' },
  })
})

it('treats a past hold as none, and offers no alternative when every other is held', () => {
  expect(claudeSessionAccount(accounts, 'c', 'round-robin', (id) => holds[id], NOW)).toEqual({
    id: 'c',
    label: 'c',
    total: 3,
    mode: 'round-robin',
    cooldownUntil: null,
    alternative: null,
  })
})

it('names the alternative by email when it has one', () => {
  expect(claudeSessionAccount(accounts, 'c', 'specific', () => null, NOW)?.alternative).toEqual({
    id: 'a',
    label: 'a@example.test',
  })
})

it('knows no account it was not given', () => {
  expect(claudeSessionAccount(accounts, 'gone', 'ordered', () => null, NOW)).toBeNull()
})
