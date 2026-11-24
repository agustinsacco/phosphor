import { expect, it } from 'vitest'
import { changedKeys, restoredConfig, sessionsKept } from './compare.mjs'

it('names changed keys without their values', () => {
  expect(changedKeys({ a: 1, b: [2], c: 3 }, { a: 1, b: [3], d: 4 })).toEqual(['b', 'c', 'd'])
})

it('requires the folder list and accounts back exactly, and counts drafts', () => {
  const saved = { recentWorkspaces: ['/a', '/b'], claudeAccounts: [{ id: 'x' }], drafts: { k: 1 } }
  expect(restoredConfig(JSON.parse(JSON.stringify(saved)), saved)).toMatchObject({
    folders: true,
    accounts: true,
    counts: { folders: 2, accounts: 1, draftsSaved: 1, draftsLive: 1 },
    changed: [],
  })
  const lost = restoredConfig({ ...saved, recentWorkspaces: [], claudeAccounts: undefined }, saved)
  expect(lost).toMatchObject({ folders: false, accounts: false })
  expect(lost.changed).toEqual(['claudeAccounts', 'recentWorkspaces'])
})

it('keeps every transcript: none missing or shrunk, growth allowed', () => {
  const before = new Map([
    ['a.jsonl', 10],
    ['b.jsonl', 20],
  ])
  expect(sessionsKept(before, new Map([...before, ['c.jsonl', 1]]))).toMatchObject({
    kept: true,
    added: 1,
  })
  expect(sessionsKept(before, new Map([['a.jsonl', 12]]))).toMatchObject({
    kept: false,
    missing: 1,
    grew: 1,
  })
  expect(
    sessionsKept(
      before,
      new Map([
        ['a.jsonl', 9],
        ['b.jsonl', 20],
      ]),
    ),
  ).toMatchObject({
    kept: false,
    shrunk: 1,
  })
})
