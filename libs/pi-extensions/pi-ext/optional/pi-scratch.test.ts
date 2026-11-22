import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { permissionDecision } from './permission-gate'

const helper = fileURLToPath(new URL('./pi-scratch.py', import.meta.url))
describe('opt-in scratch helper (Python 3.11+)', () => {
  let home: string
  let root: string
  const run = (...args: string[]): string =>
    execFileSync('python3', [helper, ...args], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pi-scratch-test-'))
    root = join(home, '.pi', 'agent', 'scratch')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('creates private jobs and cleans only the selected job, including nested files', () => {
    const job = run('create')
    const other = run('create')
    expect(job).toMatch(new RegExp('/job-[0-9a-f]{32}$'))
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(job).mode & 0o777).toBe(0o700)
    mkdirSync(join(job, 'nested'))
    writeFileSync(join(job, 'nested', 'file'), 'temporary')
    run('clean', job)
    run('clean', job)
    expect(existsSync(job)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('rejects roots, outside paths, traversal, variables, extra arguments and unnamed jobs', () => {
    const job = run('create')
    for (const target of [
      root,
      home,
      '/',
      '',
      '$t',
      `${job}/..`,
      `${root}/../scratch/${job.split('/').pop()}`,
      `${root}/unmanaged`,
    ]) {
      expect(() => run('clean', target)).toThrow()
    }
    expect(() => run('clean', job, home)).toThrow()
    expect(() => run('unknown')).toThrow()
    expect(existsSync(job)).toBe(true)
  })

  it('refuses root/job symlinks and never follows links inside a job', () => {
    const job = run('create')
    const sentinel = join(home, 'keep')
    writeFileSync(sentinel, 'important')
    symlinkSync(home, join(job, 'outside'))
    run('clean', job)
    expect(readFileSync(sentinel, 'utf8')).toBe('important')
    symlinkSync(home, job)
    expect(() => run('clean', job)).toThrow()
    rmSync(root, { recursive: true })
    symlinkSync(home, root)
    expect(() => run('create')).toThrow()
    expect(() => run('clean', job)).toThrow()
    expect(readFileSync(sentinel, 'utf8')).toBe('important')
  })

  it('refuses a shared root or a job replaced by a regular file', () => {
    const job = run('create')
    chmodSync(root, 0o755)
    expect(() => run('clean', job)).toThrow()
    expect(() => run('create')).toThrow()
    chmodSync(root, 0o700)
    rmSync(job, { recursive: true })
    writeFileSync(job, 'not a directory')
    expect(() => run('clean', job)).toThrow()
  })

  it('supports shell variables without exempting any other command in the script', () => {
    const script = `t=$(python3 "${helper}" create); python3 "${helper}" clean "$t"`
    expect(permissionDecision(script)).toBe('allow')
    execFileSync('/bin/bash', ['-euc', script], { env: { ...process.env, HOME: home } })
    expect(permissionDecision(`${script}; rm -rf /important`)).toBe('ask')
  })
})
