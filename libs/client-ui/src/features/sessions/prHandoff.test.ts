import { expect, it } from 'vitest'
import { prDetail, prSummary } from './__fixtures__/pullRequests'
import { prHandoff } from './prHandoff'

const pr = prSummary()
const ref = '#57 (https://github.com/agustinsacco/Phosphor/pull/57)'

it('names the failing check, whether it is required and why it failed', () => {
  expect(prHandoff('fix-checks', pr)).toBe(
    `Fix the failing check on ${ref}: Rocky review (not required) ("1 unresolved finding"). Read the check output, fix it on agustin/session-cli, push, and tell me when it passes.`,
  )
  expect(prHandoff('fix-checks', pr, prDetail())).toContain(
    '("Write commands need an explicit opt-in")',
  )
})

it('lists the unresolved threads when the detail is read, and counts them when not', () => {
  const draft = prHandoff('address-threads', pr, prDetail())
  expect(draft.split('\n')[0]).toBe(`Address the 4 unresolved review threads on ${ref}:`)
  expect(draft).toContain('- cli/src/run.ts:248 (rocky-bot): Preview requests')
  expect(draft.endsWith('Reply on each thread with what changed, then push.')).toBe(true)
  expect(prHandoff('address-threads', pr)).toBe(
    `Address the 4 unresolved review threads on ${ref}.\nReply on each thread with what changed, then push.`,
  )
})

it('asks the code owners first and never sends', () => {
  expect(prHandoff('nudge-owners', pr)).toBe(
    `Draft a short Slack message asking @core-reviewers to review ${ref}. Don't send it.`,
  )
  expect(prHandoff('update-branch', pr)).toContain('Merge main into agustin/session-cli')
  expect(prHandoff('mention', pr)).toBe(ref)
})
