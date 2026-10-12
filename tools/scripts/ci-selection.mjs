import { execFileSync } from 'node:child_process'

export const ALL_PROJECTS = [
  'control',
  'desktop',
  'host',
  'pi-extensions',
  'runtime',
  'schema',
  'shared',
  'site',
  'tooling',
]
const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? '')
const execute = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', timeout: 60_000 }).trim()

// Reporting only: nothing in this contract authorizes skipping a check.
export async function shadowSelection(context, github, executeCommand = execute) {
  let head = null
  let base = null
  const full = (reason) => ({ mode: 'full', reason, base, head, projects: ALL_PROJECTS })
  const git = (...args) => executeCommand('git', args)
  const ancestor = (candidate) => {
    if (!sha(candidate)) return false
    try {
      git('cat-file', '-e', `${candidate}^{commit}`)
      git('merge-base', '--is-ancestor', candidate, head)
      return true
    } catch {
      return false
    }
  }
  try {
    head = git('rev-parse', 'HEAD')
    if (!sha(head) || head !== context.sha) return full('checkout identity mismatch')
    if (git('rev-parse', '--is-shallow-repository') !== 'false') return full('shallow history')
    const { owner, repo } = context.repo
    const repository = `${owner}/${repo}`
    if (context.payload.repository?.full_name !== repository) return full('repository mismatch')
    if (context.eventName === 'pull_request') {
      const pr = context.payload.pull_request
      if (pr?.head?.repo?.full_name !== repository || pr?.base?.repo?.full_name !== repository)
        return full('fork or missing PR repository')
      base = pr.base.sha
      if (pr.base.ref !== 'main' || !ancestor(base) || !ancestor(pr.head.sha))
        return full('missing or unrelated PR history')
    } else if (context.eventName === 'push' && context.payload.ref === 'refs/heads/main') {
      if (context.payload.after !== head) return full('push identity mismatch')
      const request = { ...context.repo, workflow_id: 'ci.yml', request: { timeout: 10_000 } }
      const workflow = await github.rest.actions.getWorkflow(request)
      // A bounded search is not proof that no older successful run exists.
      for (let page = 1; page <= 3 && !base; page++) {
        const { data } = await github.rest.actions.listWorkflowRuns({
          ...request,
          branch: 'main',
          event: 'push',
          status: 'success',
          per_page: 100,
          page,
        })
        for (const run of data.workflow_runs) {
          if (
            run.workflow_id === workflow.data.id &&
            run.head_repository?.full_name === repository &&
            run.head_branch === 'main' &&
            run.event === 'push' &&
            run.status === 'completed' &&
            run.conclusion === 'success' &&
            run.id !== context.runId &&
            ancestor(run.head_sha)
          ) {
            base = run.head_sha
            break
          }
        }
        if (data.workflow_runs.length < 100) break
      }
      if (!base) return full('no eligible successful main baseline in bounded window')
    } else return full('unsupported event (including merge groups)')
    const projects = JSON.parse(
      executeCommand(process.execPath, [
        'node_modules/nx/dist/bin/nx.js',
        'show',
        'projects',
        '--affected',
        `--base=${base}`,
        `--head=${head}`,
        '--json',
      ]),
    )
    if (!Array.isArray(projects) || projects.some((project) => !ALL_PROJECTS.includes(project)))
      return full('invalid Nx project report')
    return {
      mode: 'shadow',
      reason: 'full checks remain mandatory',
      base,
      head,
      projects: projects.sort(),
    }
  } catch {
    return full('history, API or Nx query failed')
  }
}
