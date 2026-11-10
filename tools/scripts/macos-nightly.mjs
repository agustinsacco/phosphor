// Decisions for .github/workflows/macos-nightly.yml, kept here so they are tested.
//
// GitHub drops scheduled runs under load (the first 07:00 run never fired), so
// the nightly has three daily slots and runs at most once a day. Main pushes
// never take the Mac: they only check that the nightly still finishes, and open
// the `macos-nightly` issue when it has not for STALE_HOURS.

export const E2E_JOB = 'E2E full suite (macOS)'
export const LABEL = 'macos-nightly'
export const RECENT_HOURS = 20
export const STALE_HOURS = 30
const HOUR = 3_600_000
const LOOKBACK_HOURS = 72

/** The newest finished full-suite job in this workflow's recent runs, and whether one is running. */
export async function nightlyHistory(github, repo, { workflowId, currentRunId, now }) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...repo,
    workflow_id: workflowId,
    branch: 'main',
    per_page: 100,
  })
  let finished = null
  let running = false
  for (const run of data.workflow_runs) {
    // Push runs never start the suite.
    if (run.id === currentRunId || run.event === 'push') continue
    if (now - Date.parse(run.created_at) > LOOKBACK_HOURS * HOUR) continue
    const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({
      ...repo,
      run_id: run.id,
      per_page: 20,
    })
    const job = jobs.jobs.find((candidate) => candidate.name === E2E_JOB)
    if (!job) continue
    if (job.status !== 'completed') {
      running = true
      continue
    }
    if (job.conclusion === 'skipped' || !job.completed_at) continue
    const at = Date.parse(job.completed_at)
    if (!finished || at > finished.at) finished = { at, conclusion: job.conclusion }
  }
  return { finished, running }
}

/** Whether this run takes the Mac, and whether the nightly has gone quiet. */
export function decide({ event, now, history, since }) {
  const hours = (time) => (now - time) / HOUR
  const last = history.finished?.at ?? null
  if (event === 'workflow_dispatch') return { run: true, stale: false }
  if (event === 'schedule')
    return { run: !history.running && (last === null || hours(last) >= RECENT_HOURS), stale: false }
  // A push only notices a nightly that stopped finishing; it never takes the Mac.
  return { run: false, stale: !history.running && hours(last ?? since) >= STALE_HOURS }
}

/** Open, comment on or close the one `macos-nightly` issue. */
export async function report(github, repo, { decided, e2e, stale, lastAt, runUrl, sha }) {
  const { data: open } = await github.rest.issues.listForRepo({
    ...repo,
    labels: LABEL,
    state: 'open',
    per_page: 1,
  })
  const issue = open[0]
  if (decided === 'success' && e2e === 'success') {
    if (issue) {
      await github.rest.issues.createComment({
        ...repo,
        issue_number: issue.number,
        body: `Green again: ${runUrl}`,
      })
      await github.rest.issues.update({ ...repo, issue_number: issue.number, state: 'closed' })
    }
    return 'closed'
  }
  let body
  if (decided !== 'success') body = `The macOS nightly could not decide whether to run: ${runUrl}`
  else if (e2e === 'failure' || e2e === 'cancelled')
    body = `The macOS nightly e2e run ${e2e === 'failure' ? 'failed' : 'was cancelled'} on main (${sha.slice(0, 9)}): ${runUrl}`
  else if (stale) {
    // One notice per outage, not one per push.
    if (issue) return 'already open'
    const since = lastAt ? `since ${new Date(lastAt).toISOString()}` : 'since it was added'
    body = `The macOS nightly e2e has not finished ${since}. Check that the Mac runner is online and that its scheduled runs fire, then run it by hand from Actions: ${runUrl}`
  } else return 'nothing to report'
  if (issue) await github.rest.issues.createComment({ ...repo, issue_number: issue.number, body })
  else
    await github.rest.issues.create({
      ...repo,
      title: 'macOS nightly e2e is failing',
      labels: [LABEL],
      body,
    })
  return issue ? 'commented' : 'opened'
}
