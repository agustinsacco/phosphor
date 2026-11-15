import type { GhPrCheck, GhPrDetail, GhPrSummary } from '@shared/models'
import { checkFacts } from './prVerdict'

/**
 * Drafts that hand a PR's blocker to the lane's agent. They go into the
 * composer for the person to read and send; Phosphor itself never writes to
 * GitHub. The inspector's checklist buttons and PR notices share them.
 */
export type PrHandoff =
  | 'fix-checks'
  | 'address-threads'
  | 'address-changes'
  | 'update-branch'
  | 'nudge-owners'
  | 'mention'

const refText = (pr: GhPrSummary) => `#${pr.number} (${pr.url})`
const people = (names: string[]) => names.map((n) => `@${n}`).join(' and ')
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

function fixChecks(pr: GhPrSummary, detail?: GhPrDetail): string {
  const failing = checkFacts(pr).failing
  const why = (check: GhPrCheck) => {
    const run = detail?.checks?.find((c) => c.name === check.name)
    const note = run?.annotations[0]?.message ?? run?.title ?? check.title
    return note ? ` ("${clip(note, 120)}")` : ''
  }
  const names = failing.map((c) => `${c.name}${c.required ? '' : ' (not required)'}${why(c)}`)
  const list = names.length ? `: ${names.join(', ')}` : ''
  return `Fix the failing check${failing.length === 1 ? '' : 's'} on ${refText(pr)}${list}. Read the check output, fix it on ${pr.headRefName}, push, and tell me when it passes.`
}

function addressThreads(pr: GhPrSummary, detail?: GhPrDetail): string {
  const threads = detail?.threads ?? []
  const count = pr.threads?.unresolved ?? threads.length
  const lines = threads
    .slice(0, 10)
    .map(
      (t) =>
        `- ${t.path}${t.line ? `:${t.line}` : ''}${t.author ? ` (${t.author})` : ''}: ${clip(t.body.replace(/\s+/g, ' '), 100)}`,
    )
  const more = threads.length > 10 ? [`- …and ${threads.length - 10} more on GitHub`] : []
  return [
    `Address the ${count} unresolved review thread${count === 1 ? '' : 's'} on ${refText(pr)}${lines.length ? ':' : '.'}`,
    ...lines,
    ...more,
    'Reply on each thread with what changed, then push.',
  ].join('\n')
}

/** The draft for one hand-off. `detail`, when read, names the exact checks and threads. */
export function prHandoff(kind: PrHandoff, pr: GhPrSummary, detail?: GhPrDetail): string {
  switch (kind) {
    case 'fix-checks':
      return fixChecks(pr, detail)
    case 'address-threads':
      return addressThreads(pr, detail)
    case 'address-changes':
      return `${people(pr.changesRequestedBy) || 'A reviewer'} requested changes on ${refText(pr)}. Read the review, make the changes on ${pr.headRefName}, and reply on each thread.`
    case 'update-branch':
      return `Merge ${pr.baseRefName || 'the base branch'} into ${pr.headRefName} for ${refText(pr)}, resolve the conflicts, run the tests, and push.`
    case 'nudge-owners': {
      const owners = pr.waitingOn.filter((r) => r.codeOwner)
      const who =
        people((owners.length ? owners : pr.waitingOn).map((r) => r.name)) || 'the reviewers'
      return `Draft a short Slack message asking ${who} to review ${refText(pr)}. Don't send it.`
    }
    case 'mention':
      return refText(pr)
  }
}
