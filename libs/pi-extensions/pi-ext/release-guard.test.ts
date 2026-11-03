import { describe, expect, it } from 'vitest'
import { releaseBashRefusal } from './release-guard'

describe('release bash guard', () => {
  it.each([
    'gh pr merge 12 --squash',
    'cd /tmp/wt && gh pr merge 12',
    'GH_REPO=a/b gh pr merge 3',
    'gh api -X PUT repos/a/b/pulls/12/merge',
    'gh api repos/a/b/merges -f base=main -f head=x',
  ])('refuses a merge outside release_merge: %s', (command) => {
    expect(releaseBashRefusal(command)).toMatch(/release_merge/)
  })

  it.each([
    'git push --force origin fix',
    'git push --force-with-lease origin fix',
    'git -C /tmp/wt push -f origin fix',
    'git push -uf origin fix',
    'git push origin +fix',
    'echo ok; git push --force-if-includes origin fix',
  ])('refuses a force push: %s', (command) => {
    expect(releaseBashRefusal(command)).toMatch(/never force-pushes/)
  })

  it.each([
    'git push origin fix',
    'git push -u origin agustin/fix-flaky',
    'git push --follow-tags origin fix',
    'git merge origin/main',
    'gh pr view 12 --json mergeable,mergeStateStatus',
    'gh pr checks 12',
    'gh run rerun 99 --failed',
  ])('allows ordinary work: %s', (command) => {
    expect(releaseBashRefusal(command)).toBeUndefined()
  })
})
