import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { checkProviders, describeProvider } from './providers'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine()
})
afterEach(() => machine.cleanup())

/** A pi that records each argv on its own line and answers not_ready. */
function recordingPi(): {
  pi: { binaryPath: string; prefixArgs: string[] }
  calls: () => string[]
} {
  const log = join(machine.dir, 'calls.log')
  const binaryPath = machine.script(
    'recording-pi',
    `echo "$*" >> '${log}'\necho '{"status":"not_ready","reason":"credentials_not_configured"}'\nexit 1`,
  )
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').sort()
  return { pi: { binaryPath, prefixArgs: ['cli.js'] }, calls }
}

const environment = { env: { PATH: '/usr/bin:/bin' }, secrets: [] }

describe('checkProviders', () => {
  it('asks for a status only: never a credential, never the network', async () => {
    const { pi, calls } = recordingPi()
    await checkProviders(pi, environment)
    expect(calls()).toEqual(
      [
        'anthropic',
        'github-copilot',
        'kimi-for-coding',
        'openai-codex',
        'openrouter',
        'radius',
        'xai',
      ].map((id) => `cli.js auth check --provider ${id} --json --no-refresh`),
    )
  })

  it.each([
    ['the claude lane', 'pi-claude-cli'],
    ['not an id', '--credentials'],
    ['one already listed', 'xai'],
  ])("adds pi's default as a row only when it is another provider, not %s", async (_why, id) => {
    const { pi, calls } = recordingPi()
    const providers = await checkProviders(pi, environment, { defaultProvider: id })
    expect(calls()).toHaveLength(7)
    expect(providers.filter((provider) => provider.default).map((provider) => provider.id)).toEqual(
      id === 'xai' ? ['xai'] : [],
    )
  })

  it('reports a check that could not finish as unknown, with why', async () => {
    const binaryPath = machine.script('slow-pi', 'sleep 5')
    const [first] = await checkProviders({ binaryPath, prefixArgs: [] }, environment, {
      timeoutMs: 100,
    })
    expect(first).toEqual({
      id: 'openai-codex',
      name: 'ChatGPT (Codex)',
      status: 'unknown',
      reason: 'pi auth check failed: timed out',
    })
    expect(describeProvider(first!)).toBe('pi auth check failed: timed out')
  })
})
