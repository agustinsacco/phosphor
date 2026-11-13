import type { GhPrCheck, GhPrDetail, GhPrRef, GhPrSummary, GhPrThread } from '@shared/models'

/**
 * Pull requests shaped like real ones, for tests and the browser harness.
 * `blockedOnOwners` is the common case that started this work: green except an
 * optional review bot, approved twice, still waiting on a code-owner team.
 */

export const prRef = (number: number, repo = 'Phosphor', owner = 'agustinsacco'): GhPrRef => ({
  host: 'github.com',
  owner,
  repo,
  number,
})

export const prCheck = (
  name: string,
  state: GhPrCheck['state'],
  required = false,
  title?: string,
): GhPrCheck => ({ name, state, required, ...(title ? { title } : {}) })

const GREEN = [
  prCheck('build', 'success', true),
  prCheck('unit', 'success', true),
  prCheck('e2e (ubuntu)', 'success', true),
  prCheck('e2e (macos)', 'success', true),
  prCheck('lint', 'success', true),
  prCheck('Semantic PR title', 'success'),
]

export function prSummary(patch: Partial<GhPrSummary> = {}): GhPrSummary {
  const ref = patch.ref ?? prRef(patch.number ?? 57)
  return {
    ref,
    number: ref.number,
    title: 'Rebuild the session CLI on generated endpoints',
    state: 'OPEN',
    url: `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    reviewDecision: 'REVIEW_REQUIRED',
    checks: { passed: 6, failed: 1, pending: 0, total: 7 },
    headRefName: 'agustin/session-cli',
    baseRefName: 'main',
    additions: 1240,
    deletions: 986,
    changedFiles: 31,
    comments: 9,
    updatedAt: '2026-11-13T04:06:30Z',
    author: 'agustinsacco',
    headSha: 'c3b820e0c3b820e0',
    checkRuns: [...GREEN, prCheck('Rocky review', 'failure', false, '1 unresolved finding')],
    checksTruncated: false,
    approvedBy: ['mara', 'devon'],
    changesRequestedBy: [],
    waitingOn: [
      { name: 'core-reviewers', team: true, codeOwner: true },
      { name: 'lee', team: false, codeOwner: false },
    ],
    threads: { total: 12, unresolved: 4 },
    inMergeQueue: false,
    autoMerge: false,
    ...patch,
  }
}

/** Green, approved by three, waiting only on code owners. */
export const blockedOnOwners = (number = 58): GhPrSummary =>
  prSummary({
    ref: prRef(number),
    number,
    title: 'Add a knowledge-service CLI with typed commands',
    headRefName: 'agustin/knowledge-cli',
    checks: { passed: 7, failed: 0, pending: 0, total: 7 },
    checkRuns: [...GREEN, prCheck('Rocky review', 'neutral')],
    approvedBy: ['mara', 'devon', 'kim'],
    waitingOn: [{ name: 'knowledge-owners', team: true, codeOwner: true }],
    threads: { total: 8, unresolved: 0 },
    additions: 642,
    deletions: 12,
    changedFiles: 14,
    updatedAt: '2026-11-12T18:20:00Z',
  })

const THREADS: GhPrThread[] = [
  {
    path: 'cli/src/run.ts',
    line: 248,
    outdated: false,
    author: 'rocky-bot',
    body: 'Preview requests can send live messages. Both write commands now reach the generated invocation without an opt-in.',
    replies: 1,
    url: 'https://github.com/agustinsacco/Phosphor/pull/57#discussion_r1',
  },
  {
    path: 'api/lite-swagger.json',
    line: 1,
    outdated: false,
    author: 'devon',
    body: 'How does the CLI get the session context to forward downstream?',
    replies: 2,
  },
  {
    path: 'api/lite-swagger.json',
    line: 3,
    outdated: true,
    author: 'devon',
    body: 'Side note: there is already a CLI to chat with the agent.',
    replies: 0,
  },
  {
    path: 'cli/README.md',
    line: 40,
    outdated: false,
    author: 'mara',
    body: 'Document the staging flag here too.',
    replies: 0,
  },
]

export function prDetail(patch: Partial<GhPrDetail> = {}): GhPrDetail {
  return {
    ref: prRef(57),
    threads: THREADS,
    threadsTruncated: false,
    checks: [
      {
        ...prCheck('Rocky review', 'failure', false, '1 unresolved finding'),
        workflow: 'Verified reviews',
        url: 'https://github.com/agustinsacco/Phosphor/runs/1',
        startedAt: '2026-11-13T04:00:00Z',
        completedAt: '2026-11-13T04:06:30Z',
        annotations: [
          {
            path: 'cli/src/run.ts',
            line: 248,
            level: 'failure',
            message: 'Write commands need an explicit opt-in',
          },
        ],
      },
      ...GREEN.map((c, i) => ({
        ...c,
        workflow: i < 5 ? 'Checks' : 'Semantic PR title',
        startedAt: '2026-11-13T03:50:00Z',
        completedAt: `2026-11-13T03:5${i + 2}:10Z`,
        annotations: [],
      })),
    ],
    checksTruncated: false,
    commented: ['lee'],
    activity: [
      { kind: 'review', at: '2026-11-10T15:47:26Z', actor: 'devon', state: 'APPROVED' },
      { kind: 'review', at: '2026-11-10T17:46:28Z', actor: 'mara', state: 'APPROVED' },
      {
        kind: 'commit',
        at: '2026-11-13T03:49:04Z',
        actor: 'agustinsacco',
        text: 'chore: regenerate the CLI from the new spec',
      },
      {
        kind: 'requested',
        at: '2026-11-13T04:04:44Z',
        actor: 'agustinsacco',
        text: 'core-reviewers',
      },
    ],
    checkedAt: Date.parse('2026-11-13T04:10:00Z'),
    ...patch,
  }
}
