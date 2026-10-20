#!/usr/bin/env node
// Decides whether a validated main commit changes what a release ships: is
// the Nx project (`desktop`, or `host` for Host releases) affected between its
// last PUBLISHED release and this commit? Comparing against the last release, not the
// previous commit, means a Desktop change still ships when a newer push
// cancels its release run before it publishes.
//
// Every doubt resolves to releasing. An unnecessary release costs one update
// prompt; a missed one strands users on an old build.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ALL_PROJECTS } from './ci-selection.mjs'

const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? '')
const execute = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
  }).trim()

const TAGS = { desktop: /^v\d+\.\d+\.\d+$/, host: /^host-v\d+\.\d+\.\d+$/ }

export function desktopReleaseScope(releasedTag, executeCommand = execute) {
  return releaseScope('desktop', releasedTag, executeCommand)
}

export function releaseScope(project, releasedTag, executeCommand = execute) {
  let head = null
  let base = null
  const release = (reason, projects = null) => ({ release: true, reason, base, head, projects })
  const git = (...args) => executeCommand('git', args)
  try {
    head = git('rev-parse', 'HEAD')
    if (!sha(head)) return release('cannot identify the checked-out commit')
    if (!TAGS[project]?.test(releasedTag ?? '')) return release('no published release to compare')
    base = git('rev-list', '-n', '1', `refs/tags/${releasedTag}`)
    if (!sha(base)) return release('published release tag is not a commit')
    try {
      git('merge-base', '--is-ancestor', base, head)
    } catch {
      return release('published release is not on this history')
    }
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
      return release('invalid Nx project report')
    projects.sort()
    if (projects.includes(project))
      return release(`${project} changed since ${releasedTag}`, projects)
    return {
      release: false,
      reason: `${project} unchanged since ${releasedTag}`,
      base,
      head,
      projects,
    }
  } catch {
    return release('history or Nx query failed')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(releaseScope(process.argv[3] ?? 'desktop', process.argv[2])))
}
