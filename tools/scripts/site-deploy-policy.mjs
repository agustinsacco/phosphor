import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

const result = (state, reason) => ({ state, reason })

// Keep the site's hold identical to Desktop's git-trailer policy.
function skipsRelease(message) {
  const parsed = spawnSync('sh', [
    fileURLToPath(new URL('should-skip-release.sh', import.meta.url)),
    message,
  ])
  if (parsed.status === 0) return true
  if (parsed.status === 1) return false
  throw new Error('Cannot verify Skip-Release trailer')
}

/** The push path filter remains GitHub's authority, including multi-commit pushes. */
export function siteDeployDecision(context, workflow, runs) {
  const { eventName, event, repository, ref, sha, checkedOutSha, mainSha, hold, message } = context
  if (!['push', 'workflow_dispatch'].includes(eventName))
    return result('error', 'Unsupported event')
  if (ref !== 'refs/heads/main' || event.repository?.full_name !== repository)
    return result('error', 'Only this repository main may deploy')
  if (eventName === 'workflow_dispatch' && event.inputs?.confirm !== 'true')
    return result('error', 'Manual deployment requires explicit confirmation')
  if (!/^[a-f0-9]{40}$/.test(sha) || checkedOutSha !== sha || mainSha !== sha)
    return result('error', 'Deployment SHA is not the exact current main checkout')
  if (eventName === 'push' && (event.ref !== ref || event.after !== sha))
    return result('error', 'Push ref or SHA mismatch')
  if (hold && hold !== 'false') return result('skip', 'SITE_DEPLOY_HOLD blocks deployment')
  // A manual run may name the trailer explicitly to deploy anyway: Skip-Release
  // holds Desktop, and a site change can need to ship before the next Desktop
  // release. The hold variable still applies.
  const override = eventName === 'workflow_dispatch' && event.inputs?.ignore_skip_release === 'true'
  if (!override && skipsRelease(message))
    return result('skip', 'Skip-Release trailer blocks deployment')
  if (!workflow && !runs) return result('wait', 'CI verification required')
  if (
    workflow?.path !== '.github/workflows/ci.yml' ||
    workflow?.name !== 'CI' ||
    !Number.isInteger(workflow?.id) ||
    !Array.isArray(runs?.workflow_runs)
  )
    return result('error', 'Cannot verify CI workflow identity')
  const matching = runs.workflow_runs.filter(
    (run) =>
      run.workflow_id === workflow.id &&
      run.path === workflow.path &&
      run.name === 'CI' &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      run.event === 'push' &&
      run.head_branch === 'main' &&
      run.head_sha === sha,
  )
  // Newest rerun wins: an earlier green attempt must not hide a pending or red rerun.
  matching.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)
  const latest = matching[0]
  if (!latest) return result('wait', 'No matching CI run yet')
  if (latest.status !== 'completed') return result('wait', 'Exact-SHA CI is pending')
  if (latest.conclusion !== 'success')
    return result('error', `Exact-SHA CI concluded ${latest.conclusion}`)
  return result('deploy', 'Exact-SHA main CI succeeded')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const decision = siteDeployDecision(
    {
      eventName: process.env.GITHUB_EVENT_NAME,
      event: json(process.env.GITHUB_EVENT_PATH),
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      checkedOutSha: git('rev-parse', 'HEAD'),
      mainSha: process.env.MAIN_SHA,
      hold: process.env.SITE_DEPLOY_HOLD,
      message: git('log', '-1', '--format=%B'),
    },
    process.argv[2] && json(process.argv[2]),
    process.argv[3] && json(process.argv[3]),
  )
  console.log(JSON.stringify(decision))
  if (decision.state === 'error') process.exitCode = 1
}
