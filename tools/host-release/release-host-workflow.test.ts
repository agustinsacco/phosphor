import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const root = join(import.meta.dirname, '../..')
const workflow = readFileSync(join(root, '.github/workflows/release-host.yml'), 'utf8')
const steps = workflow.split(/\n {6}- (?:name|uses): /).slice(1)
const step = (name: string) => {
  const found = steps.filter((s) => s.startsWith(name))
  expect(found, name).toHaveLength(1)
  return found[0]!
}

it('runs only by hand from main, after exact-SHA CI, one release at a time', () => {
  expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:\n/m)
  expect(workflow).not.toMatch(/^\s+(push|pull_request|workflow_run|schedule):/m)
  expect(workflow).toContain("if: github.ref == 'refs/heads/main'")
  expect(workflow).toContain('group: host-release\n  cancel-in-progress: false')
  expect(step('Verify exact-SHA main CI')).toContain('run.head_sha === context.sha')
  expect(workflow.indexOf('Verify exact-SHA main CI')).toBeLessThan(workflow.indexOf('Install'))
})

it('gives the signing key to the signing step only, and verifies before publishing', () => {
  const uses = steps.filter((s) => s.includes('HOST_RELEASE_SIGNING_KEY'))
  expect(uses).toEqual([step('Sign the manifest')])
  expect(step('Build the three bundles')).toContain('installer.mjs --require')
  const verify = step('Verify the signature against the pinned keys')
  expect(verify).toContain('installer.mjs --allowed-signers')
  expect(verify).toContain('ssh-keygen -Y verify')
  expect(workflow.indexOf('Verify the signature')).toBeLessThan(workflow.indexOf('Publish host-v'))
})

it('never marks a Host release latest, so Desktop keeps releases/latest', () => {
  const publish = step('Publish host-v')
  const creates = publish.match(/gh release create/g) ?? []
  expect(creates).toHaveLength(2)
  expect(publish.match(/--latest=false/g) ?? []).toHaveLength(2)
  expect(workflow).not.toMatch(/--latest(?!=false)/)
  expect(publish).toContain('gh release upload host-latest')
})

it('refuses a version that is not X.Y.Z, already exists or is not higher than the newest', () => {
  const check = step('Check the version')
  expect(check).toContain('already exists on another commit')
  expect(check).toContain('is not higher than')
  // Every Host tag, paginated, so newer Desktop releases cannot hide one.
  expect(check).toContain('gh api --paginate')
  expect(check).toContain('git/matching-refs/tags/host-v')
  expect(check).not.toContain('--limit')
  expect(check).toContain('${{ inputs.version }}')
  // Inputs reach shell only through env, never interpolated into a script.
  for (const s of steps)
    for (const line of s.split('\n').filter((l) => l.includes('${{ inputs.')))
      expect(line, line).toMatch(/^\s+[A-Z_]+: \$\{\{ inputs\.version \}\}$|^Publish host-v/)
})

it('builds node-pty on each target runner and stages it into that target only', () => {
  const native = workflow.slice(workflow.indexOf('  native:'), workflow.indexOf('  release:'))
  for (const [target, runner] of [
    ['linux-x64', 'ubuntu-22.04'],
    ['linux-arm64', 'ubuntu-22.04-arm'],
    ['darwin-arm64', 'macos-14'],
  ])
    expect(native).toContain(`{ target: ${target}, runner: ${runner} }`)
  expect(native).not.toContain('secrets.')
  expect(native).toContain('build-native.mjs')
  // build-native resolves node-pty from apps/desktop, which has its own lockfile.
  expect(native).toContain('npm ci --prefix apps/desktop --ignore-scripts')
  expect(workflow).toContain('    needs: native\n')
  expect(step('Build the three bundles')).toContain(
    '--native "native-artifacts/host-native-$target"',
  )
})

it('resumes a failed publication from the same commit without replacing published bytes', () => {
  const publish = step('Publish host-v')
  expect(publish).toContain('if [[ "$RESUME" != true ]]; then')
  expect(publish).toContain('cmp -s "$asset"')
  expect(publish).not.toMatch(/upload "host-v[^\n]*--clobber/)
  expect(publish).toContain('[[ ${#assets[@]} -eq 6 ]]')
})
