import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

const workflow = readFileSync(resolve('.github/workflows/release-continuous.yml'), 'utf8')
const lines = workflow.split('\n')
const start = lines.findIndex((line) => line === '        run: |') + 1
const body: string[] = []
for (const line of lines.slice(start)) {
  if (line && !line.startsWith('          ')) break
  body.push(line.slice(10))
}
const step = (id: string) => {
  const from = lines.findIndex((line) => line === `        id: ${id}`)
  const run = lines.findIndex((line, index) => index > from && line === '        run: |') + 1
  const out: string[] = []
  for (const line of lines.slice(run)) {
    if (line && !line.startsWith('          ')) break
    out.push(line.slice(10))
  }
  return out.join('\n')
}
const parser = readFileSync(resolve(import.meta.dirname, 'should-skip-release.sh'), 'utf8')
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()

it.each([
  { location: 'scripts', skip: true, error: false, expected: 0, publish: false },
  { location: 'tools/scripts', skip: true, error: false, expected: 0, publish: false },
  { location: 'tools/scripts', skip: false, error: false, expected: 0, publish: true },
  { location: '', skip: true, error: false, expected: 1, publish: false },
  { location: 'tools/scripts', skip: true, error: true, expected: 7, publish: false },
  {
    location: 'tools/scripts',
    skip: true,
    error: false,
    expected: 0,
    publish: false,
    manual: true,
  },
  {
    location: 'tools/scripts',
    skip: false,
    error: false,
    expected: 0,
    publish: true,
    manual: true,
  },
])('release decision fails closed across checkout layouts: %j', (fixture) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-guard-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const git = join(bin, 'git')
    writeFileSync(
      git,
      `#!/bin/sh\ncase "$1" in\nrev-list) echo 123;;\nls-remote) exit 2;;\nlog) printf '%s\\n' "$COMMIT_MESSAGE";;\n*) exec ${JSON.stringify(realGit)} "$@";;\nesac\n`,
    )
    chmodSync(git, 0o755)
    if (fixture.location) {
      const path = join(dir, fixture.location, 'should-skip-release.sh')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, fixture.error ? '#!/bin/sh\nexit 7\n' : parser)
    }
    const output = join(dir, 'output')
    const result = spawnSync('bash', ['-c', body.join('\n')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        HEAD_MESSAGE: fixture.manual
          ? ''
          : fixture.skip
            ? 'Change\n\nSkip-Release: true'
            : 'Change',
        COMMIT_MESSAGE: fixture.skip ? 'Change\n\nSkip-Release: true' : 'Change',
      },
    })
    expect(result.status).toBe(fixture.expected)
    const recorded = readFileSync(output, 'utf8')
    expect(recorded.includes('should_release=true')).toBe(fixture.publish)
    if (!fixture.publish && fixture.expected === 0)
      expect(recorded).toContain('should_release=false')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('only eligible releases share concurrency or enter the release guard', () => {
  const eligible = `(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
    (github.event.workflow_run.conclusion == 'success' &&
     github.event.workflow_run.event == 'push' &&
     github.event.workflow_run.head_branch == 'main' &&
     github.event.workflow_run.head_repository.full_name == github.repository)`
  const compact = (value: string) => value.replace(/\s/g, '')
  const guard = workflow.match(/ {4}if: >\n([\s\S]*?) {4}outputs:/)?.[1] ?? ''
  const group = workflow.match(/ {2}group: release-\$\{\{ (.*?) \}\}/)?.[1] ?? ''
  expect(compact(guard)).toBe(compact(eligible))
  expect(compact(group)).toBe(compact(`(${eligible}) && 'main' || github.run_id`))
})

it.each([
  { helper: false, install: 0, scope: true, desktop: 'true' },
  { helper: true, install: 1, scope: false, desktop: 'true' },
  { helper: true, install: 0, scope: true, desktop: 'true' },
  { helper: true, install: 0, scope: false, desktop: 'false' },
])('release scope step only stops a release on an explicit Nx answer: %j', (fixture) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-scope-step-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    stub('npm', `exit ${fixture.install}`)
    stub('gh', 'echo v0.1.1')
    stub('node', `echo '{"release":${fixture.scope},"reason":"fixture"}'`)
    if (fixture.helper) {
      mkdirSync(join(dir, 'tools/scripts'), { recursive: true })
      writeFileSync(join(dir, 'tools/scripts/release-scope.mjs'), '')
    }
    const output = join(dir, 'output')
    const result = spawnSync('bash', ['-c', step('scope')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'owner/repo',
      },
    })
    expect(result.status).toBe(0)
    expect(readFileSync(output, 'utf8')).toBe(`desktop=${fixture.desktop}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('a CI-verified manual release skips only the desktop affected check', () => {
  const compact = (value: string) => value.replace(/\s/g, '')
  const gate =
    "steps.decide.outputs.should_release == 'true' && steps.scope.outputs.desktop != 'false'"
  expect(compact(workflow)).toContain(
    compact(`should_release: \${{ ${gate} && 'true' || 'false' }}`),
  )
  expect(compact(workflow)).toContain(
    compact(`- name: Pre-create the draft release\n        if: ${gate}`),
  )
  expect(workflow).toContain(
    "id: scope\n        if: steps.decide.outputs.should_release == 'true' && github.event_name == 'workflow_run'",
  )
})

function block(name: string, key: string): string {
  const after = workflow.slice(workflow.indexOf(`- name: ${name}`))
  const match = after.match(new RegExp(`( +)${key}: \\|\\n`))!
  const indent = match[1].length + 2
  const body: string[] = []
  for (const line of after.slice(match.index! + match[0].length).split('\n')) {
    if (line && !line.startsWith(' '.repeat(indent))) break
    body.push(line.slice(indent))
  }
  return body.join('\n')
}

const sha = 'a'.repeat(40)
const repo = { owner: 'owner', repo: 'repo' }
const ci = { id: 42, path: '.github/workflows/ci.yml', name: 'CI' }
const green = {
  workflow_id: ci.id,
  path: ci.path,
  name: ci.name,
  repository: { full_name: 'owner/repo' },
  head_repository: { full_name: 'owner/repo' },
  event: 'push',
  head_branch: 'main',
  head_sha: sha,
  status: 'completed',
  conclusion: 'success',
  run_number: 1,
  run_attempt: 1,
}

it.each([
  {},
  { event: 'pull_request' },
  { head_branch: 'feature' },
  { head_sha: 'b'.repeat(40) },
  { workflow_id: 43 },
  { path: 'other.yml' },
  { name: 'Other' },
  { repository: { full_name: 'fork/repo' } },
  { head_repository: { full_name: 'fork/repo' } },
  { status: 'in_progress' },
  { conclusion: 'failure' },
  { conclusion: 'cancelled' },
  { conclusion: 'skipped' },
])('manual release verifies the actual CI identity and result: %j', async (overrides) => {
  const actions = {
    getWorkflow: vi.fn(async () => ({ data: ci })),
    listWorkflowRuns: vi.fn(async () => ({
      data: { workflow_runs: [{ ...green, ...overrides }] },
    })),
  }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const verify = new AsyncFunction(
    'context',
    'github',
    'require',
    block('Verify manual release CI', 'script'),
  )
  const result = verify({ ref: 'refs/heads/main', sha, repo }, { rest: { actions } }, () => ({
    execFileSync: () => sha,
  }))
  if (Object.keys(overrides).length) await expect(result).rejects.toThrow()
  else await expect(result).resolves.toBeUndefined()
  expect(actions.listWorkflowRuns).toHaveBeenCalledWith({
    ...repo,
    workflow_id: 'ci.yml',
    branch: 'main',
    event: 'push',
    head_sha: sha,
    per_page: 100,
  })
})

it('manual release rejects missing CI, stale green attempts, wrong refs/checkouts and API errors', async () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const verify = new AsyncFunction(
    'context',
    'github',
    'require',
    block('Verify manual release CI', 'script'),
  )
  for (const fixture of [
    { runs: [] },
    { runs: [green, { ...green, run_attempt: 2, conclusion: 'failure' }] },
    { runs: [green, { ...green, run_number: 2, status: 'queued' }] },
    { runs: [green], ref: 'refs/heads/feature' },
    { runs: [green], checkout: 'b'.repeat(40) },
    { runs: [green], workflow: { ...ci, id: null } },
    { runs: [green], error: true },
  ]) {
    const actions = {
      getWorkflow: async () => ({ data: fixture.workflow ?? ci }),
      listWorkflowRuns: async () => {
        if (fixture.error) throw Error('API unavailable')
        return { data: { workflow_runs: fixture.runs } }
      },
    }
    await expect(
      verify({ ref: fixture.ref ?? 'refs/heads/main', sha, repo }, { rest: { actions } }, () => ({
        execFileSync: () => fixture.checkout ?? sha,
      })),
    ).rejects.toThrow()
  }
})

it('pins all checkouts, filters main completions, and keeps failed builds unpublished', () => {
  expect(workflow).toContain('workflows: [CI]\n    branches: [main]')
  expect(
    workflow.match(/ref: \$\{\{ github.event.workflow_run.head_sha \|\| github.sha \}\}/g),
  ).toHaveLength(3)
  expect(workflow).toContain('--config.publish.releaseType=draft')
  expect(workflow).toContain("if: ${{ success() && needs.guard.outputs.should_release == 'true' }}")
  expect(block('Publish checksums', 'run')).not.toContain('|| true')
})

it.each([
  { draft: true, target: sha, exists: true, create: 0, expected: 0 },
  { draft: false, target: sha, exists: true, create: 0, expected: 1 },
  { draft: true, target: 'b'.repeat(40), exists: true, create: 0, expected: 1 },
  { draft: false, target: '', exists: false, create: 0, expected: 0 },
  { draft: false, target: '', exists: false, create: 1, expected: 1 },
])('creates once or resumes only the same SHA draft: %j', (fixture) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-draft-'))
  try {
    const shell = block('Pre-create the draft release', 'run')
      .replaceAll('${{ steps.decide.outputs.tag }}', 'v0.1.123')
      .replaceAll('${{ github.event.workflow_run.head_sha || github.sha }}', sha)
    const mock = `gh() { case "$2" in
      view) printf '%s' "$DRAFT"; return ${fixture.exists ? 0 : 1};;
      create) return ${fixture.create};;
      *) return 99;; esac; };\n`
    const result = spawnSync('bash', ['-c', mock + shell], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_TEMP: dir,
        DRAFT: JSON.stringify({ isDraft: fixture.draft, targetCommitish: fixture.target }),
      },
    })
    expect(result.status, result.stdout + result.stderr).toBe(fixture.expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('requires every platform binary and update manifest, including on retries', () => {
  const shell = block('Verify install.sh can resolve its assets', 'run')
    .replaceAll('${{ needs.guard.outputs.tag }}', 'v0.1.123')
    .replaceAll('${{ needs.guard.outputs.version }}', '0.1.123')
  const assets = [
    'x86_64.AppImage',
    'arm64.AppImage',
    'x64.dmg',
    'arm64.dmg',
    'x64.exe',
    'amd64.deb',
    'arm64.deb',
    'mac.zip',
    'arm64-mac.zip',
  ]
    .map((suffix) => `Phosphor-0.1.123-${suffix}`)
    .concat(['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'])
  for (const missing of [null, ...assets]) {
    const result = spawnSync('bash', ['-c', 'gh() { printf "%s\\n" "$ASSETS"; };\n' + shell], {
      encoding: 'utf8',
      env: { ...process.env, ASSETS: assets.filter((a) => a !== missing).join('\n') },
    })
    expect(result.status, result.stdout + result.stderr).toBe(missing ? 1 : 0)
  }
})

it.each([
  { latest: 'v0.1.100', notes: 0, previous: 'v0.1.100', listed: true },
  { latest: '', notes: 0, previous: null, listed: true },
  { latest: 'v0.1.123', notes: 0, previous: null, listed: true },
  { latest: 'v0.1.100', notes: 1, previous: 'v0.1.100', listed: false },
])('publishes the PRs since the last published release: %j', (fixture) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'))
  try {
    const shell = block('Publish the release', 'run')
      .replaceAll('${{ github.event.workflow_run.head_sha || github.sha }}', sha)
      .replaceAll('${{ needs.guard.outputs.version }}', '0.1.123')
      .replaceAll('${{ needs.guard.outputs.tag }}', 'v0.1.123')
      .replaceAll('${{ github.repository }}', 'owner/repo')
    const calls = join(dir, 'calls')
    const mock = `gh() {
      printf '%s\\n' "$*" >> "$CALLS"
      case "$1 $2" in
        "api repos/owner/repo/releases/latest") [ -n "$LATEST" ] && echo "$LATEST"; return 0;;
        "api --method") [ "$NOTES_STATUS" = 0 ] && echo '* Desktop: a change by @me in #7'; return $NOTES_STATUS;;
        "release edit") printf '%s' "$5 $6 $7" > "$CALLS.edit"; return 0;;
        *) return 99;; esac; };\n`
    const result = spawnSync('bash', ['-c', mock + shell], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CALLS: calls,
        LATEST: fixture.latest,
        NOTES_STATUS: String(fixture.notes),
      },
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const generate = readFileSync(calls, 'utf8')
      .split('\n')
      .find((call) => call.includes('generate-notes'))!
    expect(generate).toContain(`tag_name=v0.1.123 -f target_commitish=${sha}`)
    if (fixture.previous) expect(generate).toContain(`previous_tag_name=${fixture.previous}`)
    else expect(generate).not.toContain('previous_tag_name')
    const edit = readFileSync(`${calls}.edit`, 'utf8')
    expect(edit).toContain('--latest --notes')
    expect(edit.includes('* Desktop: a change by @me in #7')).toBe(fixture.listed)
    expect(edit).toContain('releases/latest/download/install.sh')
    expect(result.stdout.includes('::warning::')).toBe(!fixture.listed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
