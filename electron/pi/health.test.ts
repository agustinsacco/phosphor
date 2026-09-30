import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIN_PI_VERSION } from '@shared/models'
import { setActiveAgent } from './agent'
import {
  cachedAgentHealth,
  checkActiveAgentHealth,
  checkPiHealth,
  compareVersions,
  extractVersion,
  invalidateAgentHealth,
} from './health'

// No login shell and no log file: only the binaries each test names may run.
vi.mock('./shell-env', () => ({
  getLoginShellPath: vi.fn().mockResolvedValue(null),
  piProcessEnv: vi.fn().mockResolvedValue({ PATH: '/usr/bin:/bin' }),
}))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

describe('version comparison', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('0.78.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.78.0', '0.78.0')).toBe(0)
    expect(compareVersions('0.77.9', '0.78.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
  })

  it('tolerates differing segment counts', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })
})

describe('version extraction', () => {
  it('reads a bare version line', () => {
    expect(extractVersion('0.78.0\n')).toBe('0.78.0')
  })

  it('finds the version among surrounding noise', () => {
    // Version managers and pi itself can emit warnings first.
    expect(extractVersion('Warning: settings.json parse error\n0.78.0\n')).toBe('0.78.0')
    expect(extractVersion('pi version 0.83.1')).toBe('0.83.1')
  })

  it('supports prerelease suffixes', () => {
    expect(extractVersion('0.84.0-beta.2')).toBe('0.84.0-beta.2')
  })

  it('returns null when there is no version at all', () => {
    // The regression: `env: node: No such file or directory` on stderr with
    // empty stdout must not be mistaken for a version string.
    expect(extractVersion('')).toBeNull()
    expect(extractVersion('env: node: No such file or directory')).toBeNull()
  })
})

describe('agent health', () => {
  let dir: string
  const script = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-health-'))
  })
  afterEach(() => {
    setActiveAgent(undefined)
    invalidateAgentHealth()
    rmSync(dir, { recursive: true, force: true })
  })

  it('checks the selected agent, and never holds omp to the pi version floor', async () => {
    const omp = script('omp', 'echo omp/18.4.2')
    setActiveAgent({ kind: 'omp', binaryPaths: { pi: '', omp } })
    const health = await checkActiveAgentHealth()
    expect(health).toMatchObject({ ok: true, agent: 'omp', binaryPath: omp, version: '18.4.2' })
    expect(health.minVersion).toBeUndefined()
  })

  it('still gates pi on MIN_PI_VERSION', async () => {
    const pi = script('pi', 'echo 0.1.0')
    setActiveAgent({ kind: 'pi', binaryPaths: { pi, omp: '' } })
    expect(await checkActiveAgentHealth()).toMatchObject({
      ok: false,
      agent: 'pi',
      reason: 'too-old',
      minVersion: MIN_PI_VERSION,
    })
  })

  it('reports an explicit binary that does not run instead of falling back to PATH', async () => {
    const missing = join(dir, 'nope', 'omp')
    setActiveAgent({ kind: 'omp', binaryPaths: { pi: '', omp: missing } })
    expect(await checkActiveAgentHealth()).toMatchObject({
      ok: false,
      agent: 'omp',
      binaryPath: missing,
      reason: 'version-check-failed',
    })
  })

  it('keeps pi-only surfaces on pi while omp is selected', async () => {
    const pi = script('pi', `echo ${MIN_PI_VERSION}`)
    const omp = script('omp', 'echo omp/18.4.2')
    setActiveAgent({ kind: 'omp', binaryPaths: { pi, omp } })
    expect(await checkPiHealth()).toMatchObject({ ok: true, agent: 'pi', binaryPath: pi })
  })

  it('never answers with the previous agent from the cache', async () => {
    const pi = script('pi', `echo ${MIN_PI_VERSION}`)
    const omp = script('omp', 'echo omp/18.4.2')
    setActiveAgent({ kind: 'pi', binaryPaths: { pi, omp } })
    expect((await cachedAgentHealth()).agent).toBe('pi')
    setActiveAgent({ kind: 'omp', binaryPaths: { pi, omp } })
    expect(await cachedAgentHealth()).toMatchObject({ agent: 'omp', binaryPath: omp })
  })

  it('never hands a probe still running for the previous agent to the new one', async () => {
    const pi = script('pi', `sleep 1; echo ${MIN_PI_VERSION}`)
    const omp = script('omp', 'echo omp/18.4.2')
    setActiveAgent({ kind: 'pi', binaryPaths: { pi, omp } })
    const stillProbingPi = cachedAgentHealth()
    setActiveAgent({ kind: 'omp', binaryPaths: { pi, omp } })
    invalidateAgentHealth()
    expect(await cachedAgentHealth()).toMatchObject({ agent: 'omp', binaryPath: omp })
    expect(await stillProbingPi).toMatchObject({ agent: 'pi', binaryPath: pi })
  })
})
