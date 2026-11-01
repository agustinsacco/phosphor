import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { siteDeployDecision } from './site-deploy-policy.mjs'

const sha = 'a'.repeat(40)
const repository = 'owner/Phosphor'
const context = {
  eventName: 'push',
  event: { repository: { full_name: repository }, ref: 'refs/heads/main', after: sha },
  repository,
  ref: 'refs/heads/main',
  sha,
  checkedOutSha: sha,
  mainSha: sha,
  hold: '',
  message: 'feat: update site',
}
const workflow = { id: 42, name: 'CI', path: '.github/workflows/ci.yml' }
const run = {
  workflow_id: workflow.id,
  name: workflow.name,
  path: workflow.path,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  event: 'push',
  head_branch: 'main',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  run_number: 10,
  run_attempt: 1,
}
const runs = { workflow_runs: [run] }

function decision(overrides = {}, runOverrides = {}) {
  return siteDeployDecision({ ...context, ...overrides }, workflow, {
    workflow_runs: [{ ...run, ...runOverrides }],
  }).state
}

describe('site-deploy-policy', () => {
  it('admits only a successful CI push on the exact current main checkout', () => {
    expect(decision()).toBe('deploy')
  })

  it.each(['pull_request', 'workflow_run', 'merge_group'])('rejects %s events', (eventName) => {
    expect(decision({ eventName })).toBe('error')
  })

  it.each(['refs/heads/feature', 'refs/tags/v1', 'refs/pull/1/merge'])('rejects ref %s', (ref) => {
    expect(decision({ ref })).toBe('error')
  })

  it.each(['sha', 'checkedOutSha', 'mainSha'])('rejects a mismatched %s', (key) => {
    expect(decision({ [key]: 'b'.repeat(40) })).toBe('error')
  })

  it('rejects mismatched push identity and repository', () => {
    for (const event of [
      { ...context.event, after: 'b'.repeat(40) },
      { ...context.event, ref: 'refs/heads/feature' },
      { ...context.event, repository: { full_name: 'fork/Phosphor' } },
    ])
      expect(decision({ event })).toBe('error')
  })

  it.each(['true', '1', 'FALSE', ' false ', 'migration'])('honors fail-closed hold %s', (hold) => {
    expect(decision({ hold })).toBe('skip')
  })

  it.each(['', 'false'])('permits hold %j', (hold) => {
    expect(decision({ hold })).toBe('deploy')
  })

  it.each(['true', 'YES', '1'])('honors actual Skip-Release trailer %s', (value) => {
    expect(decision({ message: `chore: migrate\n\nSkip-Release: ${value}` })).toBe('skip')
  })

  it.each([
    'docs: explain Skip-Release: true',
    'docs: explain hold\n\nUse `Skip-Release: true` to hold deployment.',
    'docs: example\n\n    Skip-Release: true',
    'feat: ship\n\nSkip-Release: false',
  ])('does not treat prose or negative trailers as a hold: %s', (message) => {
    expect(decision({ message })).toBe('deploy')
  })

  it('requires explicit manual confirmation and main, without bypassing CI or holds', () => {
    const manual = {
      eventName: 'workflow_dispatch',
      event: { repository: context.event.repository, inputs: { confirm: 'true' } },
    }
    expect(decision(manual)).toBe('deploy')
    expect(decision({ ...manual, event: { ...manual.event, inputs: {} } })).toBe('error')
    expect(decision({ ...manual, event: { ...manual.event, inputs: { confirm: 'false' } } })).toBe(
      'error',
    )
    expect(decision({ ...manual, ref: 'refs/heads/feature' })).toBe('error')
    expect(decision(manual, { conclusion: 'failure' })).toBe('error')
    expect(decision({ ...manual, hold: 'true' })).toBe('skip')
    expect(decision({ ...manual, message: 'chore: hold\n\nSkip-Release: true' })).toBe('skip')
  })

  it('lets only a confirmed manual run that names the trailer deploy past Skip-Release', () => {
    const held = 'chore: hold\n\nSkip-Release: true'
    const inputs = { confirm: 'true', ignore_skip_release: 'true' }
    const manual = {
      eventName: 'workflow_dispatch',
      event: { repository: context.event.repository, inputs },
      message: held,
    }
    expect(decision(manual)).toBe('deploy')
    expect(decision({ ...manual, hold: 'true' })).toBe('skip')
    expect(
      decision({ ...manual, event: { ...manual.event, inputs: { ...inputs, confirm: 'false' } } }),
    ).toBe('error')
    expect(
      decision({
        ...manual,
        event: { ...manual.event, inputs: { ...inputs, ignore_skip_release: 'false' } },
      }),
    ).toBe('skip')
    expect(decision({ message: held, event: { ...context.event, inputs } })).toBe('skip')
  })

  it('waits for absent and pending CI, rather than treating absence as success', () => {
    expect(siteDeployDecision(context).state).toBe('wait')
    expect(siteDeployDecision(context, workflow, { workflow_runs: [] }).state).toBe('wait')
    expect(decision({}, { status: 'queued', conclusion: null })).toBe('wait')
    expect(decision({}, { status: 'in_progress', conclusion: null })).toBe('wait')
  })

  it.each(['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', null])(
    'rejects completed CI %s',
    (conclusion) => {
      expect(decision({}, { conclusion })).toBe('error')
    },
  )

  it('ignores green runs with a different workflow, repo, branch, event or SHA', () => {
    for (const mismatch of [
      { workflow_id: 43 },
      { name: 'Other' },
      { path: '.github/workflows/other.yml' },
      { repository: { full_name: 'fork/Phosphor' } },
      { head_repository: { full_name: 'fork/Phosphor' } },
      { head_branch: 'feature' },
      { event: 'pull_request' },
      { head_sha: 'b'.repeat(40) },
    ])
      expect(decision({}, mismatch)).toBe('wait')
  })

  it('fails closed for unverifiable API responses', () => {
    expect(siteDeployDecision(context, { ...workflow, id: undefined }, runs).state).toBe('error')
    expect(siteDeployDecision(context, { ...workflow, path: 'other.yml' }, runs).state).toBe(
      'error',
    )
    expect(siteDeployDecision(context, workflow, {}).state).toBe('error')
  })

  it('does not let an earlier green run hide the newest pending or failed rerun', () => {
    for (const latest of [
      { ...run, run_attempt: 2, conclusion: 'failure' },
      { ...run, run_number: 11, status: 'queued' },
    ])
      expect(
        siteDeployDecision(context, workflow, { workflow_runs: [run, latest] }).state,
      ).not.toBe('deploy')
  })

  it('preserves GitHub push-range relevance when only an earlier pushed commit changed site', () => {
    const event = {
      ...context.event,
      before: 'b'.repeat(40),
      commits: [
        { id: 'c'.repeat(40), modified: ['apps/site/src/pages/index.astro'] },
        { id: sha, modified: ['docs/overview.md'] },
      ],
    }
    expect(decision({ event })).toBe('deploy')
    expect(
      decision({ event, message: 'refactor(site): relocate to apps/site\n\nSkip-Release: true' }),
    ).toBe('skip')
    expect(decision({ event, hold: 'migration' })).toBe('skip')
  })
})

describe('deploy-site workflow trust and path wiring', () => {
  const source = readFileSync(
    new URL('../../.github/workflows/deploy-site.yml', import.meta.url),
    'utf8',
  )

  it('retains path-filtered main pushes, not PR CI completion triggers', () => {
    expect(source).toContain('branches: [main]')
    for (const path of [
      'apps/site/**',
      '.infra/phosphor-site/**',
      '.github/workflows/deploy-site.yml',
    ])
      expect(source).toContain(`- '${path}'`)
    expect(source).not.toMatch(/^ {2}(workflow_run|pull_request|pull_request_target):/m)
    expect(source).not.toContain('git diff')
  })

  it('isolates rejected manual requests from production concurrency', () => {
    expect(source).toContain("github.ref == 'refs/heads/main' && inputs.confirm == true")
    expect(source).toContain("&& 'production' || github.run_id")
    expect(source).toContain('default: false')
  })

  it('gates secrets and builds on the exact approved SHA and rechecks stale main', () => {
    expect(source).toContain("if: needs.guard.outputs.should_deploy == 'true'")
    expect(source).toContain('ref: ${{ needs.guard.outputs.sha }}')
    expect(source).toContain('${{ env.IMAGE_NAME }}:${{ needs.guard.outputs.sha }}')
    expect(source.match(/Recheck current main before/g)).toHaveLength(2)
    expect(source).toContain('sleep 15')
    expect(source).toContain('seq 1 360')
    expect(source).toContain('exit 1')
  })

  it.each([
    { successAt: 45, expectedExit: 0, polls: 45, mockPolicy: true, failure: false },
    { successAt: 361, expectedExit: 1, polls: 360, mockPolicy: true, failure: false },
    { successAt: 1, expectedExit: 0, polls: 1, mockPolicy: false, failure: false },
    { successAt: 1, expectedExit: 1, polls: 1, mockPolicy: false, failure: true },
  ])(
    'polls actual workflow shell through $polls checks (mockPolicy=$mockPolicy, failure=$failure)',
    ({ successAt, expectedExit, polls, mockPolicy, failure }) => {
      const fixture = mkdtempSync(join(tmpdir(), 'site-deploy-policy-'))
      const binary = (name: string, contents: string) => {
        const path = join(fixture, name)
        writeFileSync(path, contents)
        chmodSync(path, 0o755)
      }
      try {
        const start =
          source.indexOf('        run: |', source.indexOf('- name: Wait for CI')) +
          '        run: |\n'.length
        const end = source.indexOf('\n  build-and-deploy:', start)
        const shell = source
          .slice(start, end)
          .split('\n')
          .map((line) => line.slice(10))
          .join('\n')
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
        binary(
          'git',
          `#!/bin/sh\ncase "$1" in\nrev-parse) echo "$GITHUB_SHA";;\nlog) echo 'feat: site';;\n*) exec "${realGit}" "$@";;\nesac\n`,
        )
        binary('sleep', '#!/bin/sh\necho "$1" >> "$RUNNER_TEMP/sleeps"\n')
        binary(
          'gh',
          `#!/bin/bash
set -eu
test "$1" = api
case "$2" in
  "repos/$GITHUB_REPOSITORY/git/ref/heads/main") echo "$GITHUB_SHA";;
  "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=$GITHUB_SHA&per_page=100")
    count=0
    if [ -f "$RUNNER_TEMP/polls" ]; then read -r count < "$RUNNER_TEMP/polls"; fi
    count=$((count + 1))
    echo "$count" > "$RUNNER_TEMP/polls"
    status=in_progress
    conclusion=null
    if [ "$count" -ge "$SUCCESS_AT" ]; then status=completed; conclusion='"success"'; fi
    if [ "$FAILURE" = true ]; then status=completed; conclusion='"failure"'; fi
    printf '{"workflow_runs":[{"workflow_id":42,"name":"CI","path":".github/workflows/ci.yml","repository":{"full_name":"owner/Phosphor"},"head_repository":{"full_name":"owner/Phosphor"},"event":"push","head_branch":"main","head_sha":"%s","status":"%s","conclusion":%s,"run_number":10,"run_attempt":1}]}\\n' "$GITHUB_SHA" "$status" "$conclusion";;
  "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml") echo '{"id":42,"name":"CI","path":".github/workflows/ci.yml"}';;
  *) exit 64;;
esac
`,
        )
        // Long-loop coverage isolates the policy CLI to avoid hundreds of Node startups.
        // The two short cases below compose this same shell with the real policy CLI.
        if (mockPolicy)
          binary(
            'node',
            `#!/bin/bash
set -eu
test "$1" = tools/scripts/site-deploy-policy.mjs
if [ "$#" -eq 1 ]; then
  echo preliminary >> "$RUNNER_TEMP/policy-calls"
  echo '{"state":"wait"}'
elif [ "$#" -eq 3 ]; then
  test "$2" = "$RUNNER_TEMP/site-ci-workflow.json" && test -s "$2"
  test "$3" = "$RUNNER_TEMP/site-ci-runs.json" && test -s "$3"
  echo verified >> "$RUNNER_TEMP/policy-calls"
  read -r count < "$RUNNER_TEMP/polls"
  if [ "$count" -ge "$SUCCESS_AT" ]; then echo '{"state":"deploy"}'; else echo '{"state":"wait"}'; fi
else
  exit 64
fi
`,
          )
        writeFileSync(join(fixture, 'event.json'), JSON.stringify(context.event))
        // Source the shell mocks as functions to avoid process-startup cost under
        // the full suite's CPU load. The production loop and real jq stay intact.
        const mocks =
          'gh() { source "$RUNNER_TEMP/gh"; }; sleep() { source "$RUNNER_TEMP/sleep"; };\n' +
          (mockPolicy ? 'node() { source "$RUNNER_TEMP/node"; };\n' : '')
        const outcome = spawnSync('bash', ['-c', mocks + shell], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${fixture}:${process.env.PATH}`,
            RUNNER_TEMP: fixture,
            GITHUB_OUTPUT: join(fixture, 'output'),
            GITHUB_EVENT_PATH: join(fixture, 'event.json'),
            GITHUB_EVENT_NAME: 'push',
            GITHUB_REF: context.ref,
            GITHUB_SHA: sha,
            GITHUB_REPOSITORY: repository,
            SITE_DEPLOY_HOLD: '',
            GH_TOKEN: 'synthetic',
            SUCCESS_AT: String(successAt),
            FAILURE: String(failure),
          },
        })
        expect(outcome.status, outcome.stdout + outcome.stderr).toBe(expectedExit)
        expect(Number(readFileSync(join(fixture, 'polls'), 'utf8'))).toBe(polls)
        const sleeps =
          polls > 1 ? readFileSync(join(fixture, 'sleeps'), 'utf8').trim().split('\n') : []
        expect(sleeps).toHaveLength(polls - 1)
        if (mockPolicy) {
          const calls = readFileSync(join(fixture, 'policy-calls'), 'utf8').trim().split('\n')
          expect(calls).toHaveLength(polls * 2)
          expect(calls.filter((call) => call === 'preliminary')).toHaveLength(polls)
          expect(calls.filter((call) => call === 'verified')).toHaveLength(polls)
        }
        expect(sleeps.every((interval) => interval === '15')).toBe(true)
        const output = readFileSync(join(fixture, 'output'), 'utf8')
        expect(output.includes('should_deploy=true')).toBe(expectedExit === 0)
      } finally {
        rmSync(fixture, { recursive: true, force: true })
      }
    },
  )
})
