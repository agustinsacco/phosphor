import { describe, expect, it, vi } from 'vitest'
import { MIN_PI_VERSION } from '@phosphor/shared/models'
import { checkReadiness, piReadiness, claudeReadiness, tailscaleReadiness } from './readiness'
import { PROBE_OUTPUT_CAP, type ProbeResult } from './probe'

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
    const probe = vi.fn(
      async (
        _file: string,
        args: readonly string[],
        options: { timeoutMs?: number; env: Record<string, string> },
      ) => {
        expect(options.timeoutMs).toBe(2000)
        expect(options.env.HOME).toBe('/home/u')
        return result(
          args.includes('--version')
            ? MIN_PI_VERSION
            : args.includes('auth')
              ? '{"loggedIn":true}'
              : '{"BackendState":"Running"}',
        )
      },
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
  it('finds a pinned executable at the filesystem root and maps all missing binaries', async () => {
    const which = vi.fn(async (_name: string, _path: string) => null)
    const probe = vi.fn(async () => result(''))
    expect(
      await checkReadiness(
        { version: 1, pi: { executable: '/pi' }, repositories: ['/repo'] },
        { PATH: '/bin' },
        'linux',
        { probe, which, isNodeScript: async () => false },
      ),
    ).toEqual({ pi: 'missing', claude: 'missing', tailscale: 'missing' })
    expect(which.mock.calls[0]).toEqual(['pi', '/'])
    expect(probe).not.toHaveBeenCalled()
  })
  it('does not launch a Node script without the pinned node', async () => {
    const probe = vi.fn(async () => result(''))
    expect(
      await checkReadiness(
        { version: 1, pi: { executable: '/bin/pi' }, repositories: ['/repo'] },
        {},
        'linux',
        {
          probe,
          which: async (name) => (name === 'pi' ? '/bin/pi' : null),
          isNodeScript: async () => true,
        },
      ),
    ).toEqual({ pi: 'unknown', claude: 'missing', tailscale: 'missing' })
    expect(probe).not.toHaveBeenCalled()
  })
  it.each([
    [piReadiness, MIN_PI_VERSION],
    [claudeReadiness, '{"loggedIn":true}'],
    [tailscaleReadiness, '{"BackendState":"Running","CertDomains":["host.ts.net"]}'],
  ])('accepts complete output at the cap, not truncated output one byte beyond', (map, text) => {
    expect(map(result(text + ' '.repeat(PROBE_OUTPUT_CAP - text.length)))).toBe('ok')
    expect(
      map(result(text + ' '.repeat(PROBE_OUTPUT_CAP + 1 - text.length), { truncated: true })),
    ).toBe('unknown')
  })
})
