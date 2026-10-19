import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_CLAUDE_ACCOUNT_PREFS } from '@phosphor/shared/models'
import { createAccountMetadata } from './account-metadata'

const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

it('rechecks current authority before the atomic metadata replacement and cleans its temporary', () => {
  const root = mkdtempSync(join(tmpdir(), 'account-metadata-'))
  roots.push(root)
  let checks = 0
  let revoke = false
  const metadata = createAccountMetadata({
    root,
    allowed: () => !revoke || ++checks < 2,
  })
  metadata.write(structuredClone(DEFAULT_CLAUDE_ACCOUNT_PREFS))
  const before = readFileSync(join(root, 'accounts.json'), 'utf8')
  revoke = true
  expect(() => metadata.write({ ...metadata.read(), mode: 'round-robin' })).toThrow('revoked')
  expect(checks).toBe(2)
  expect(readFileSync(join(root, 'accounts.json'), 'utf8')).toBe(before)
  expect(readdirSync(root)).toEqual(['accounts.json'])
})
