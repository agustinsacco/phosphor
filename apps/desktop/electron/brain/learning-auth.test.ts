import { expect, it } from 'vitest'
import type { ClaudeAccountPrefs } from '@phosphor/shared/models'
import { qualifyLearningClaudePackage, selectLearningClaudeAccount } from './learning-auth'
const prefs: ClaudeAccountPrefs = {
  accounts: [
    {
      id: 'explicit',
      label: 'Synthetic account',
      credentialDir: '/synthetic/slot',
      orgId: 'synthetic-org',
      addedAt: 0,
    },
    { id: 'default', label: 'Other', credentialDir: null, addedAt: 0 },
  ],
  mode: 'round-robin',
  cursor: 1,
  cooldowns: {},
  bindings: { '/source.jsonl': 'explicit' },
}
it('reads the exact existing Claude assignment and never rotates/defaults/writes prefs or credentials', () => {
  const before = structuredClone(prefs)
  expect(selectLearningClaudeAccount(prefs, '/source.jsonl')).toEqual({
    accountId: 'explicit',
    env: {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/synthetic/slot',
      CLAUDE_CODE_ORGANIZATION_UUID: 'synthetic-org',
    },
  })
  expect(selectLearningClaudeAccount(prefs, '/unsaved.jsonl', 'explicit').accountId).toBe(
    'explicit',
  )
  expect(() => selectLearningClaudeAccount(prefs, '/unbound.jsonl')).toThrow('explicit')
  expect(() => selectLearningClaudeAccount(prefs, '/source.jsonl', 'default')).toThrow(
    'conflicting',
  )
  expect(() =>
    selectLearningClaudeAccount(
      { ...prefs, bindings: { '/source.jsonl': 'deleted' } },
      '/source.jsonl',
    ),
  ).toThrow()
  expect(prefs).toEqual(before)
})
it('refuses old, ambiguous, missing, or multiple provider entrypoints and qualifies only the explicit installed CLI package', () => {
  const pkg = {
    name: '@saccolabs/pi-claude-cli',
    version: '0.11.0',
    installed: true,
    installPath: '/synthetic/provider',
    resources: { extensions: ['/synthetic/provider/index.ts'] },
  }
  expect(qualifyLearningClaudePackage([pkg])).toEqual({
    providerExtension: '/synthetic/provider/index.ts',
    claudeVersion: '0.11.0',
  })
  for (const packages of [
    [],
    [pkg, pkg],
    [{ ...pkg, version: '0.10.9' }],
    [{ ...pkg, resources: { extensions: [] } }],
    [{ ...pkg, name: 'custom' }],
  ])
    expect(() => qualifyLearningClaudePackage(packages)).toThrow()
})
