import { beforeEach, expect, it } from 'vitest'
import { normalizePrefix } from '@shared/branchName'
import { newChatBranchName } from '@/features/sessions/startChat'
import { useWorktreesStore } from '@/stores/worktrees'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { remoteBranchName } from './remoteBranchName'

beforeEach(() => {
  useLanePrefsStore.getState().applyLanePrefs({ branchSlugMaxLength: 40 })
  useWorktreesStore.setState({ branchPrefix: 'phosphor/' })
})
it('reuses This Mac naming without imposing the Host cap on This Mac', () => {
  const prompt = 'Fix the café composer'
  expect(remoteBranchName(prompt)).toBe(
    newChatBranchName(prompt, { takenBranches: [], takenFolders: [] }).branch,
  )
  useWorktreesStore.setState({ branchPrefix: 'p'.repeat(70) })
  const local = newChatBranchName('a'.repeat(40), { takenBranches: [], takenFolders: [] }).branch
  expect(local.length).toBe(111)
  const remote = remoteBranchName('a'.repeat(40))
  expect(remote).toHaveLength(100)
  expect(remote.startsWith(normalizePrefix('p'.repeat(70)))).toBe(true)
  for (let attempt = 2; attempt <= 5; attempt++) {
    const branch = remoteBranchName('a'.repeat(40), attempt)
    expect(branch).toHaveLength(100)
    expect(branch.endsWith(`-${attempt}`)).toBe(true)
  }
})
it('allows exactly one slug character, but refuses a prefix that leaves none', () => {
  useWorktreesStore.setState({ branchPrefix: 'p'.repeat(98) })
  expect(remoteBranchName('task')).toBe(`${'p'.repeat(98)}/t`)
  useWorktreesStore.setState({ branchPrefix: 'p'.repeat(99) })
  expect(() => remoteBranchName('task')).toThrow('branch-prefix-too-long')
})
