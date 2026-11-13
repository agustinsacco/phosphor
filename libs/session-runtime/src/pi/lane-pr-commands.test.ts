import { describe, expect, it } from 'vitest'
import { branchesCreatedBy, commandSegments, reviewedBy, stripHeredocs } from './lane-pr-commands'

describe('branchesCreatedBy', () => {
  it.each([
    ['git worktree add -b agustin/a ../wt/a origin/main', ['agustin/a']],
    ['git worktree add ../wt/b -B agustin/b', ['agustin/b']],
    ['cd ../wt && git checkout -b fix/x origin/main', ['fix/x']],
    ['git switch -c feat/y', ['feat/y']],
    ['git switch --create=feat/z', ['feat/z']],
    ['git -C ../wt push -u origin agustin/c 2>&1 | tail -3', ['agustin/c']],
    ['git push --force-with-lease origin HEAD:agustin/d', ['agustin/d']],
    ['git push origin +refs/heads/e:refs/heads/agustin/e', ['agustin/e']],
    ['git push -o ci.skip origin agustin/f', ['agustin/f']],
    ['gh pr create --head octo:agustin/g --base main --title "x"', ['agustin/g']],
    ['GIT_TRACE=1 git push origin "agustin/h"', ['agustin/h']],
  ])('%s', (command, branches) => {
    expect(branchesCreatedBy(command)).toEqual(branches)
  })

  it.each([
    'git push',
    'git push -u origin HEAD',
    'git push origin main',
    'git push origin :agustin/old',
    'git push --delete origin agustin/old',
    'git push origin --tags',
    'git checkout agustin/existing',
    'git switch main',
    'git checkout -b "$BRANCH"',
    'echo git push origin agustin/not-run',
    'git branch -m agustin/a agustin/b',
  ])('reads nothing from %s', (command) => {
    expect(branchesCreatedBy(command)).toEqual([])
  })

  it('ignores a heredoc body that quotes a push', () => {
    const command = [
      "cat > /tmp/body.md <<'EOF'",
      'Run `git push origin agustin/quoted` to try it.',
      'EOF',
      'gh pr create --body-file /tmp/body.md --head agustin/real',
    ].join('\n')
    expect(branchesCreatedBy(stripHeredocs(command))).toEqual(['agustin/real'])
  })
})

describe('commandSegments', () => {
  it('splits on separators outside quotes and keeps quoted words whole', () => {
    expect(commandSegments(`a "b && c" && d 'e;f'; g\\ h | i`)).toEqual([
      ['a', 'b && c'],
      ['d', 'e;f'],
      ['g h'],
      ['i'],
    ])
  })

  it('keeps a here-string while a heredoc body goes', () => {
    expect(stripHeredocs('cat <<<"EOF"\ngit push origin agustin/x')).toContain('agustin/x')
  })
})

describe('reviewedBy', () => {
  it('reads URLs, -R refs and bare numbers', () => {
    expect(
      reviewedBy(
        [
          'gh pr diff https://github.com/GoAugment/augment-services/pull/20264 --name-only',
          'gh pr checkout 812 -R GoAugment/augment-dbt',
          'gh pr review 19190 --comment -b "LGTM"',
          'gh pr comment --body "x" 19801',
        ].join(' && '),
      ),
    ).toEqual({
      refs: [
        { host: 'github.com', owner: 'GoAugment', repo: 'augment-services', number: 20264 },
        { host: 'github.com', owner: 'GoAugment', repo: 'augment-dbt', number: 812 },
      ],
      numbers: [19190, 19801],
    })
  })

  it('ignores status peeks and branch names', () => {
    expect(reviewedBy('gh pr view 1 && gh pr checks 2 && gh pr checkout agustin/x')).toEqual({
      refs: [],
      numbers: [],
    })
  })
})
