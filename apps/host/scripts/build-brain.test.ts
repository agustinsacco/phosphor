import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { prepareBrain } from './build-brain.mjs'

const build = join(import.meta.dirname, 'build.mjs')
let temp: string

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'host-brain-build-'))
})
afterEach(() => rmSync(temp, { force: true, recursive: true }))

function run(...args: string[]) {
  return spawnSync(process.execPath, [build, '--out', join(temp, 'dist'), ...args], {
    encoding: 'utf8',
  })
}

it('does not prepare inference when qualification or smoke was not requested', async () => {
  expect(await prepareBrain(temp, 'darwin-arm64', undefined, false, undefined)).toBeNull()
})

it('refuses a Brain-enabled bundle for a target outside the embedding allowlist', () => {
  const built = run('--target', 'linux-arm64', '--brain-model', join(temp, 'model'))
  expect(built.status).not.toBe(0)
  expect(built.stderr).toContain('Host Brain is not supported on linux-arm64')
  expect(existsSync(join(temp, 'dist'))).toBe(false)
}, 90_000)

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'fails before staging when the offline model files are missing',
  () => {
    const built = run('--target', 'darwin-arm64', '--brain-model', join(temp, 'model'))
    expect(built.status).not.toBe(0)
    expect(built.stderr).toContain(
      'The offline Host Brain model is missing files or failed manifest verification',
    )
    expect(existsSync(join(temp, 'dist'))).toBe(false)
  },
  90_000,
)
