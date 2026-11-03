import { describe, expect, it } from 'vitest'
import { releaseBashRefusal } from './release-guard'

describe('release bash guard', () => {
  it.each([
    'gh pr merge 12 --squash',
    'cd /tmp/wt && gh pr merge 12',
    'GH_REPO=a/b gh pr merge 3',
    'gh api -X PUT repos/a/b/pulls/12/merge',
    'gh api repos/a/b/merges -f base=main -f head=x',
    'gh pr -R a/b merge 3',
    'gh --repo a/b pr merge 3',
    'gh api --method PUT repos/a/b/pulls/3/merge',
    'gh api graphql -f query=mutation{mergePullRequest(input:{})}',
    'gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"',
    'gh api graphql -F query=@merge.graphql -f q="mergeBranch"',
    "sh -c 'gh pr merge 3'",
    'bash -lc "cd x && gh pr merge 3"',
    'eval "gh pr merge 3"',
    'echo $(gh pr merge 3)',
    'echo `gh pr merge 3`',
    'env GH_TOKEN=x gh pr merge 3',
    'timeout 60 nice -n 5 gh pr merge 3',
    'echo 3 | xargs gh pr merge',
    'gh pr merge \\\n  3',
    'true\ngh pr merge 3',
    'sleep 1 & gh pr merge 3',
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
    'git push --mirror origin',
    'git push --prune origin main:main',
    'git push --all origin',
    'git push origin --delete fix',
    'git push -d origin fix',
    'git push origin :fix',
    "git push origin '+fix'",
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin fix:refs/heads/main',
    "sh -c 'git push -f origin fix'",
    'cd wt || exit; git push origin HEAD:main',
  ])('refuses a push that rewrites, deletes or lands on the base: %s', (command) => {
    expect(releaseBashRefusal(command)).toMatch(/never force-pushes/)
  })

  it('protects the base the policy names', () => {
    expect(releaseBashRefusal('git push origin HEAD:trunk', 'trunk')).toMatch(/never force/)
    expect(releaseBashRefusal('git push origin main', 'trunk')).toBeUndefined()
  })

  it.each([
    'git push origin fix',
    'git push -u origin agustin/fix-flaky',
    'git push --follow-tags origin fix',
    'git push origin HEAD:fix-branch',
    'git push origin main-fix',
    'git push',
    'git merge origin/main',
    'gh pr view 12 --json mergeable,mergeStateStatus',
    'gh pr view 3',
    'gh pr checks 12',
    'gh run rerun 99 --failed',
    'gh api repos/a/b/pulls/3/merge',
    'gh api graphql -f query="query { repository(owner: \\"a\\", name: \\"b\\") { pullRequest(number: 3) { mergeable } } }"',
    'git commit -m "never push --force"',
    'git commit -F msg',
    `gh pr comment 12 --body "please don't git push -f over my merge"`,
    'rg -n "gh pr merge" docs/',
    "echo 'gh pr merge 3'",
    'grep -f patterns.txt',
  ])('allows ordinary work: %s', (command) => {
    expect(releaseBashRefusal(command)).toBeUndefined()
  })
})
