#!/usr/bin/env node
/* global fetch, AbortSignal */
// Which runner the macOS e2e leg takes: the project's own Mac when it is
// online, else a GitHub-hosted Mac. A job sent to an offline self-hosted runner
// queues until that runner returns, which held every PR for hours whenever the
// Mac slept. GitHub has no fallback of its own, so `changes` asks first.
//
// Listing runners needs a token with repository Administration (read), which
// GITHUB_TOKEN never has: RUNNER_STATUS_TOKEN. Without it (a fork, or before
// the secret is set), and on every doubt, the leg goes to GitHub's Mac, which
// always starts. A busy Mac still counts as available: it takes one job at a
// time and gets to this one.
//
// Prints `mac=<runs-on JSON>` for $GITHUB_OUTPUT and the reason on stderr.
import { pathToFileURL } from 'node:url'

export const OWN_MAC = ['self-hosted', 'macOS', 'ARM64']
export const HOSTED_MAC = 'macos-15'

/** The runs-on value for a runner list, as the runners API returns it. */
export function macRunner(runners) {
  const macs = (Array.isArray(runners) ? runners : []).filter((runner) =>
    OWN_MAC.every((label) => runner?.labels?.some?.((l) => l?.name === label)),
  )
  if (macs.some((runner) => runner.status === 'online'))
    return { runsOn: OWN_MAC, reason: 'the project Mac is online' }
  return {
    runsOn: HOSTED_MAC,
    reason: macs.length ? 'the project Mac is offline' : 'no project Mac is registered',
  }
}

export async function pickMacRunner({ token, repository, request = fetch }) {
  const hosted = (reason) => ({ runsOn: HOSTED_MAC, reason })
  if (!token) return hosted('no RUNNER_STATUS_TOKEN, so runner status is unknown')
  if (!/^[\w-]+\/(?!\.\.?$)[\w.-]+$/.test(repository ?? '')) return hosted('no repository')
  try {
    const response = await request(
      `https://api.github.com/repos/${repository}/actions/runners?per_page=100`,
      {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!response.ok) return hosted(`the runner list answered ${response.status}`)
    return macRunner((await response.json())?.runners)
  } catch {
    return hosted('the runner list could not be read')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { runsOn, reason } = await pickMacRunner({
    token: process.env.RUNNER_STATUS_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
  })
  console.error(`macOS e2e: ${JSON.stringify(runsOn)} (${reason})`)
  console.log(`mac=${JSON.stringify(runsOn)}`)
}
