import { describe, expect, it, vi } from 'vitest'
import { MIN_PI_VERSION } from '@phosphor/shared/models'
import { checkReadiness, piReadiness, claudeReadiness, tailscaleReadiness } from './readiness'
import type { ProbeResult } from './probe'

const result = (stdout: string, extra: Partial<ProbeResult> = {}): ProbeResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated: false,
  ...extra,
})
describe('readiness mappings', () => {
  it.each([
    [null, 'missing'],
    [result(MIN_PI_VERSION), 'ok'],
    [result('0.1.0'), 'outdated'],
    [result('bad'), 'unknown'],
    [result(MIN_PI_VERSION, { code: 1 }), 'unknown'],
    [result(MIN_PI_VERSION, { timedOut: true }), 'unknown'],
    [result(MIN_PI_VERSION, { truncated: true }), 'unknown'],
    [result(MIN_PI_VERSION, { error: 'secret' }), 'unknown'],
    [result(MIN_PI_VERSION, { signal: 'SIGKILL' }), 'unknown'],
  ])('pi %j maps to %s', (run, expected) => expect(piReadiness(run)).toBe(expected))
  it.each([
    [null, 'missing'],
    [result('{"loggedIn":true}'), 'ok'],
    [result('{"loggedIn":false}', { code: 1 }), 'signed-out'],
    [result('{"loggedIn":"true"}'), 'unknown'],
    [result('bad'), 'unknown'],
    [result('{"loggedIn":true}', { code: 2 }), 'unknown'],
    [result('{"loggedIn":true}', { timedOut: true }), 'unknown'],
    [result('{"loggedIn":true}', { truncated: true }), 'unknown'],
    [result('{"loggedIn":true}', { error: 'secret' }), 'unknown'],
  ])('claude %j maps to %s', (run, expected) => expect(claudeReadiness(run)).toBe(expected))
  it.each([
    [null, 'missing'],
    [result('{"BackendState":"Running","CertDomains":["host.ts.net"]}'), 'ok'],
    [result('{"BackendState":"Stopped"}'), 'stopped'],
    [result('{"BackendState":"NeedsLogin"}'), 'stopped'],
    [result('{"BackendState":"Running"}'), 'no-https'],
    [result('{"BackendState":"Running","CertDomains":[]}'), 'no-https'],
    [result('{"BackendState":"Running","CertDomains":null}'), 'no-https'],
    [result('{"BackendState":"Running","CertDomains":[4]}'), 'unknown'],
    [result('{}'), 'unknown'],
    [result('bad'), 'unknown'],
    [result('{"BackendState":"Running"}', { code: 1 }), 'unknown'],
    [result('{"BackendState":"Running"}', { timedOut: true }), 'unknown'],
    [result('{"BackendState":"Running"}', { truncated: true }), 'unknown'],
    [result('{"BackendState":"Running"}', { error: 'secret' }), 'unknown'],
  ])('tailscale %j maps to %s', (run, expected) => expect(tailscaleReadiness(run)).toBe(expected))
  it('uses existing probe port, argv arrays, two second deadlines and pi environment', async () => {
    const probe = vi.fn(async (_file: string, args: readonly string[]) =>
      result(
        args.includes('--version')
          ? MIN_PI_VERSION
          : args.includes('auth')
            ? '{"loggedIn":true}'
            : '{"BackendState":"Running"}',
      ),
    )
    expect(
      await checkReadiness(
        { version: 1, pi: { executable: '/p/pi', node: '/p/node' }, repositories: ['/repo'] },
        { PATH: '/p', HOME: '/home/u' },
        'linux',
        { probe, which: async (name) => `/p/${name}`, isNodeScript: async () => true },
      ),
    ).toEqual({ pi: 'ok', claude: 'ok', tailscale: 'no-https' })
    expect(probe.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['/p/node', ['/p/pi', '--version']],
      ['/p/claude', ['auth', 'status']],
      ['/p/tailscale', ['status', '--json']],
    ])
    for (const call of probe.mock.calls) expect(call).toHaveLength(3)
  })
})
