import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { prepare } from './prepare.mjs'
import { sensitiveName, manifestChanges } from './manifest.mjs'
import { assertRoots, layout } from './assert-scratch.mjs'

let root, source, user, agent
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'r0-'))
  source = mkdtempSync(join(tmpdir(), 'r0-src-'))
  user = join(source, 'profile')
  agent = join(source, 'pi')
  mkdirSync(user)
  mkdirSync(agent)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(source, { recursive: true, force: true })
})

it.each([
  'AUTH-secret.JSON',
  '.env.local',
  'id.pem',
  '.credentials.json',
  'login.keychain-db',
  'models.json',
])('omits %s without opening it', (name) => expect(sensitiveName(name)).toBe(true))
it('compares names, hashes and inode identity, not just counts', () => {
  expect(manifestChanges({ a: [1, 'x'], b: [] }, { a: [2, 'x'], c: [] })).toEqual(['a', 'b', 'c'])
})
it('refuses an outside root, relative path, and a dangling symlink ancestor', () => {
  symlinkSync(join(source, 'not-there'), join(root, 'escape'))
  for (const path of [source, 'relative', join(root, 'escape', 'new')])
    expect(() => assertRoots(root, { socket: path })).toThrow()
})
it('copies only migration inputs, leaving excluded trees unopened and accounts empty', async () => {
  mkdirSync(join(user, 'claude-accounts', 'synthetic-id'), { recursive: true })
  symlinkSync(source, join(user, 'claude-accounts', 'synthetic-id', 'do-not-follow'))
  symlinkSync(source, join(agent, 'npm'))
  symlinkSync(source, join(agent, 'auth-test.json'))
  mkdirSync(join(agent, 'sessions'))
  writeFileSync(join(agent, 'sessions', 'lane.jsonl'), 'synthetic lane')
  await prepare(root, user, agent)
  const roots = layout(root)
  expect(readdirSync(roots.agent)).toEqual(['sessions'])
  expect(readdirSync(join(roots.userData, 'claude-accounts', 'synthetic-id'))).toEqual([])
  writeFileSync(join(roots.agent, 'sessions', 'lane.jsonl'), 'different')
  expect(readFileSync(join(agent, 'sessions', 'lane.jsonl'), 'utf8')).toBe('synthetic lane')
  await expect(prepare(root, user, agent)).rejects.toThrow()
})
it.each(['symlink', 'hardlink'])('refuses a %s at an allowed name', async (kind) => {
  writeFileSync(join(source, 'other'), 'synthetic')
  ;(kind === 'symlink' ? symlinkSync : linkSync)(join(source, 'other'), join(user, 'config.json'))
  await expect(prepare(root, user, agent)).rejects.toThrow()
})

it('refuses the wrong scratch mode before listing the inputs', async () => {
  const { chmodSync } = await import('node:fs')
  chmodSync(root, 0o755)
  await expect(prepare(root, user, agent)).rejects.toThrow('unsafe rehearsal root')
})

it('points copied prefs and archive records at the scratch copy, leaving the source as it was', async () => {
  const recorded = {
    userData: '/Users/me/Library/Application Support/Phosphor',
    agent: '/Users/me/.pi/agent',
  }
  const prefs = JSON.stringify({
    pinnedSessions: [`${recorded.agent}/sessions/d/a.jsonl`],
    claudeAccounts: { accounts: [{ credentialDir: `${recorded.userData}/claude-accounts/x` }] },
  })
  writeFileSync(join(user, 'config.json'), prefs)
  mkdirSync(join(user, 'lane-archive'))
  writeFileSync(
    join(user, 'lane-archive', 'a.json'),
    JSON.stringify({ transcript: `${recorded.agent}/sessions/d/b.jsonl` }),
  )
  await prepare(root, user, agent, recorded)
  const real = realpathSync(root)
  const roots = layout(root)
  expect(JSON.parse(readFileSync(join(roots.userData, 'config.json'), 'utf8'))).toEqual({
    pinnedSessions: [`${real}/agent/sessions/d/a.jsonl`],
    claudeAccounts: { accounts: [{ credentialDir: `${real}/user-data/claude-accounts/x` }] },
  })
  expect(JSON.parse(readFileSync(join(roots.userData, 'lane-archive', 'a.json'), 'utf8'))).toEqual({
    transcript: `${real}/agent/sessions/d/b.jsonl`,
  })
  expect(readFileSync(join(user, 'config.json'), 'utf8')).toBe(prefs)
})
