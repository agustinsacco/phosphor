#!/usr/bin/env node
// Which optional CI jobs a change needs, from Nx's affected projects. Only a
// pull request is narrowed: a main push runs everything, because a newer push
// cancels the older one's CI, so a skip on main could ship an untested change.
//
// Every doubt runs the job. Prints `job=true|false` lines for $GITHUB_OUTPUT.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ALL_PROJECTS } from './release-scope.mjs'

/** Each optional job and the Nx projects whose change runs it. */
export const JOB_PROJECTS = {
  e2e: ['desktop'],
  web: ['web'],
  control: ['control', 'schema'],
  site: ['site'],
}

const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? '')
const execute = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
  }).trim()

export function ciScope(event, executeCommand = execute) {
  const all = (reason) => ({
    reason,
    jobs: Object.fromEntries(Object.keys(JOB_PROJECTS).map((job) => [job, true])),
  })
  if (event !== 'pull_request') return all(`${event || 'unknown'} event runs everything`)
  try {
    const git = (...args) => executeCommand('git', args)
    // A PR checkout is GitHub's merge commit: its first parent is the base it merges into.
    const head = git('rev-parse', 'HEAD')
    const base = git('rev-parse', 'HEAD^1')
    if (!sha(head) || !sha(base)) return all('cannot identify the merge commit')
    const files = git('diff', '--name-only', base, head).split('\n').filter(Boolean)
    if (files.some((file) => file.startsWith('.github/')))
      return all('a workflow changed, so every job runs')
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
      return all('invalid Nx project report')
    const jobs = Object.fromEntries(
      Object.entries(JOB_PROJECTS).map(([job, owners]) => [
        job,
        owners.some((project) => projects.includes(project)),
      ]),
    )
    return { reason: `affected: ${projects.sort().join(', ') || 'none'}`, jobs }
  } catch {
    return all('git or Nx query failed')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { reason, jobs } = ciScope(process.argv[2])
  console.error(reason)
  for (const [job, run] of Object.entries(jobs)) console.log(`${job}=${run}`)
}
