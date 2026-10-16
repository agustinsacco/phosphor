import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, SECRET, type FakeMachine } from '../__fixtures__/machine'
import type { DoctorContext } from './doctor'
import { renderProviders, runProviders, SIGN_IN_STEPS, type ProvidersReport } from './providers'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine()
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  machine.cleanup()
})

const context = (overrides: Partial<DoctorContext> = {}): DoctorContext => ({
  configPath: machine.configPath,
  env: machine.hostEnv,
  platform: 'linux',
  uid: process.getuid!(),
  home: machine.home,
  hostname: 'bee1',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/nonexistent',
  probeTimeoutMs: 5_000,
  tailscale: { which: async () => null, probe: vi.fn() },
  ...overrides,
})

async function report(overrides: Partial<DoctorContext> = {}): Promise<ProvidersReport> {
  const outcome = await runProviders(context(overrides))
  if (!('report' in outcome)) throw new Error(outcome.problem)
  return outcome.report
}

describe('phosphor providers', () => {
  it('exits 69 with the sign-in steps while nothing is signed in', async () => {
    const result = await report()
    expect(result).toMatchObject({ ok: false, exitCode: 69, hostId: 'test-host' })
    expect(result.next).toBe(SIGN_IN_STEPS)
    expect(result.providers.every((provider) => provider.status === 'not_ready')).toBe(true)
    expect(result.claude.available).toBe(false)
  })

  it('names the missing prerequisite once a provider is signed in, and never shows its credential', async () => {
    machine.signIn('github-copilot', 'xai')
    const result = await report()
    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(result.next).toBe('Tailscale is missing: install Tailscale first.')
    const ready = result.providers.filter((provider) => provider.status === 'ready')
    expect(ready.map((provider) => provider.id)).toEqual(['github-copilot', 'xai'])
    for (const text of [JSON.stringify(result), renderProviders(result)]) {
      expect(text).not.toContain(SECRET)
    }
  })

  it('takes the claude lane alone as enough to run on', async () => {
    machine.installClaude()
    const result = await report()
    expect(result).toMatchObject({ ok: true, exitCode: 0, claude: { available: true } })
  })

  it("lists pi's default provider when it is not one pi signs into, marked", async () => {
    machine.signIn('openai')
    writeFileSync(join(machine.agentDir, 'settings.json'), '{"defaultProvider":"openai"}')
    const result = await report()
    expect(result.providers.at(-1)).toEqual({
      id: 'openai',
      name: 'openai',
      status: 'ready',
      default: true,
    })
    expect(renderProviders(result)).toContain("signed in (openai, pi's default)")
  })

  it('names what went wrong when pi answers with something it cannot read', async () => {
    const invalid = await report({ env: { ...machine.hostEnv, PI_FAKE_AUTH: 'invalid' } })
    expect(invalid.providers[0]).toMatchObject({ status: 'unknown', reason: 'invalid_state' })
    expect(renderProviders(invalid)).toContain('pi could not read its models or credentials')
    const garbage = await report({ env: { ...machine.hostEnv, PI_FAKE_AUTH: 'garbage' } })
    expect(garbage.providers[0]).toMatchObject({
      status: 'unknown',
      reason: 'pi auth check failed (exit 1): something went wrong',
    })
    expect(garbage.exitCode).toBe(69)
  })

  it('still answers when doctor fails elsewhere, and says to fix that next', async () => {
    machine.signIn('openai-codex')
    machine.writeConfig({ ...machine.config, repositories: [join(machine.dir, 'gone')] })
    const result = await report()
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      next: 'fix what phosphor doctor reports',
    })
  })

  it("hands back doctor's report when pi itself is unusable", async () => {
    const outcome = await runProviders(
      context({ env: { ...machine.hostEnv, PI_FAKE_MODE: 'leak' } }),
    )
    expect(outcome).toMatchObject({
      exitCode: 69,
      problem: 'pi is not usable here, so it was not asked about providers',
      doctor: { ok: false, lanes: { native: { reason: 'failed: pi' } } },
    })
  })

  it('renders one line per provider, the claude lane and the next step', async () => {
    machine.signIn('openai-codex')
    const text = renderProviders(await report())
    expect(text).toMatch(/^phosphor providers · test-host\n/)
    expect(text).toContain('\n  ok    ChatGPT (Codex)  signed in (openai-codex)\n')
    expect(text).toContain('\n  -     Claude Pro/Max   not signed in (anthropic)\n')
    expect(text).toContain('\nclaude lane: unavailable: ')
    expect(text).toMatch(/\nnext: Tailscale is missing: install Tailscale first\.\n$/)
  })
})
