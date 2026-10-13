import { describe, expect, it, vi } from 'vitest'
import { HOST_API_PORT } from '@phosphor/shared/host-protocol'
import type { HostConfigV1 } from '../config/schema'
import { exitCodeFor } from '../checks'
import { PROBE_OUTPUT_CAP, type ProbeResult } from './probe'
import {
  inspectTailscale,
  selfName,
  serveEndpoint,
  serveRoute,
  setupTailscaleHint,
  tailscaleChecks,
} from './tailscale'

const name = 'bee.tail123.ts.net'
const port = HOST_API_PORT
const status = {
  BackendState: 'Running',
  Self: { DNSName: `${name}.`, HostName: 'not a URL' },
  CertDomains: [name],
}
const route = () => ({
  TCP: { [port]: { HTTPS: true } },
  Web: { [`${name}:${port}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
})
const result = (stdout: string, extra: Partial<ProbeResult> = {}): ProbeResult => ({
  stdout,
  stderr: 'private output',
  code: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  ...extra,
})
const classify = (value: unknown) => serveRoute(JSON.stringify(value), port, name, port)

describe('tailscale parsers', () => {
  it('validates the endpoint independently of the name and route parsers', () => {
    expect(serveEndpoint(name, 'ours', port)).toBe(`https://${name}:${port}`)
    for (const state of ['absent', 'other', 'funnel', 'unknown'] as const)
      expect(serveEndpoint(name, state, port)).toBeNull()
    for (const badName of [
      null,
      'bee.example.com',
      'user@bee.ts.net',
      'bee.ts.net/path',
      'UPPER.ts.net',
      'bee.ts.net\n',
      'x'.repeat(254) + '.ts.net',
    ])
      expect(serveEndpoint(badName, 'ours', port)).toBeNull()
    const longest = `${'x'.repeat(246)}.ts.net`
    expect(serveEndpoint(longest, 'ours', port)).toBe(`https://${longest}:${port}`)
    expect(serveEndpoint(name, 'ours', 65535)).toBe(`https://${name}:65535`)
    expect(serveEndpoint(name, 'ours', 65536)).toBeNull()
  })

  it('uses only the running, certified DNS name, removing one trailing dot', () => {
    expect(selfName(JSON.stringify(status))).toBe(name)
    expect(selfName(JSON.stringify({ ...status, Self: { DNSName: name } }))).toBe(name)
    for (const patch of [
      { BackendState: 'Stopped' },
      { Self: null },
      { Self: { HostName: name } },
      { CertDomains: [] },
      { CertDomains: [4] },
      { CertDomains: null },
    ])
      expect(selfName(JSON.stringify({ ...status, ...patch }))).toBeNull()
    for (const dns of [
      'UPPER.ts.net',
      'bee.example.com',
      'bee.ts.net..',
      'bee ts.net',
      'https://bee.ts.net',
      `${'x'.repeat(64)}.ts.net`,
      'bee.ts.net\n',
    ]) {
      expect(
        selfName(JSON.stringify({ ...status, Self: { DNSName: dns }, CertDomains: [dns] })),
      ).toBeNull()
    }
    const longest = `${'x'.repeat(63)}.ts.net`
    expect(
      selfName(JSON.stringify({ ...status, Self: { DNSName: longest }, CertDomains: [longest] })),
    ).toBe(longest)
  })
  it.each([
    [{}, 'absent'],
    [{ Web: route().Web }, 'other'],
    [{ AllowFunnel: { [`other.ts.net:${port}`]: true } }, 'other'],
    [{ TCP: { 443: { HTTPS: true } }, Web: { 'other.ts.net:443': {} } }, 'absent'],
    [route(), 'ours'],
    [
      {
        ...route(),
        TCP: { ...route().TCP, 443: { TCPForward: 'elsewhere' } },
        Web: { ...route().Web, 'elsewhere:443': { anything: true } },
        Unknown: true,
      },
      'ours',
    ],
    [
      {
        ...route(),
        Web: { [`${name}:${port}`]: { Handlers: { '/': { Proxy: 'http://localhost:47615' } } } },
      },
      'other',
    ],
    [
      {
        ...route(),
        Web: {
          [`${name}:${port}`]: {
            Handlers: {
              '/': { Proxy: `http://127.0.0.1:${port}` },
              '/extra': { Proxy: 'elsewhere' },
            },
          },
        },
      },
      'other',
    ],
    [
      {
        ...route(),
        Web: {
          [`${name}:${port}`]: { Handlers: { '/path': { Proxy: `http://127.0.0.1:${port}` } } },
        },
      },
      'other',
    ],
    [{ ...route(), TCP: { [port]: { TCPForward: '127.0.0.1:22' } } }, 'other'],
    [{ ...route(), TCP: { [port]: { HTTP: true } } }, 'other'],
    [{ ...route(), AllowFunnel: { [`${name}:${port}`]: true } }, 'funnel'],
    [{ AllowFunnel: { [`${name}:${port}`]: true } }, 'funnel'],
    [{ TCP: null, Web: [], AllowFunnel: { [`${name}:${port}`]: true } }, 'funnel'],
    [{ ...route(), AllowFunnel: { [`${name}:443`]: true } }, 'ours'],
    [{ ...route(), AllowFunnel: { [`${name}:${port}`]: false } }, 'ours'],
    [{ ...route(), Web: { ...route().Web, [`other.ts.net:${port}`]: { Handlers: {} } } }, 'other'],
    [{ ...route(), TCP: { [port]: { HTTPS: true, Unknown: true } } }, 'other'],
    [
      {
        ...route(),
        Web: {
          [`${name}:${port}`]: {
            Handlers: { '/': { Proxy: `http://127.0.0.1:${port}`, Unknown: true } },
          },
        },
      },
      'other',
    ],
    [{ Web: null }, 'unknown'],
    [{ TCP: [] }, 'unknown'],
    [{ AllowFunnel: false }, 'unknown'],
  ])('classifies fixture %j as %s', (value, expected) => expect(classify(value)).toBe(expected))
  it('rejects non-objects and bounds input at exactly 64 KiB', () => {
    for (const value of [null, undefined, 4, {}, 'bad', '[]', 'null']) {
      expect(selfName(value)).toBeNull()
      expect(serveRoute(value, port, name, port)).toBe('unknown')
    }
    const unicode = JSON.stringify({ ...status, Unknown: 'é'.repeat(PROBE_OUTPUT_CAP / 2) })
    expect(selfName(unicode)).toBeNull()
    expect(serveRoute(unicode, port, name, port)).toBe('unknown')
    const text = JSON.stringify(status)
    expect(selfName(text + ' '.repeat(PROBE_OUTPUT_CAP - text.length))).toBe(name)
    expect(selfName(text + ' '.repeat(PROBE_OUTPUT_CAP + 1 - text.length))).toBeNull()
    expect(serveRoute('{}' + ' '.repeat(PROBE_OUTPUT_CAP - 2), port, name, port)).toBe('absent')
    expect(serveRoute('{}' + ' '.repeat(PROBE_OUTPUT_CAP - 1), port, name, port)).toBe('unknown')
  })
})
describe('tailscale probes and presentation', () => {
  const config: HostConfigV1 = { version: 1, pi: { executable: '/pi' }, repositories: ['/repo'] }
  it.each(['ours', 'absent', 'other', 'funnel', 'unknown'] as const)(
    'reports %s without publishing other routes',
    async (state) => {
      const serve =
        state === 'ours'
          ? JSON.stringify(route())
          : state === 'absent'
            ? '{}'
            : state === 'other'
              ? '{"TCP":{"47615":{"HTTP":true}}}'
              : state === 'funnel'
                ? JSON.stringify({ ...route(), AllowFunnel: { [`${name}:${port}`]: true } })
                : 'bad'
      const probe = vi.fn(
        async (
          _file: string,
          args: readonly string[],
          options: { timeoutMs?: number; env: Record<string, string> },
        ) => {
          expect(options.timeoutMs).toBe(2000)
          expect(options.env.HOME).toBe('/temp/home')
          expect(options.env.NODE_OPTIONS).toBeUndefined()
          return result(args[0] === 'status' ? JSON.stringify(status) : serve)
        },
      )
      const found = await inspectTailscale(
        config,
        { HOME: '/temp/home', PATH: '/host', NODE_OPTIONS: 'poison' },
        'linux',
        { which: async () => '/fake/tailscale', probe },
      )
      expect(found.state).toBe(state)
      expect(found.name).toBe(name)
      expect(found.endpoint).toBe(state === 'ours' ? `https://${name}:${port}` : null)
      expect(probe.mock.calls.map((call) => call.slice(0, 2))).toEqual([
        ['/fake/tailscale', ['status', '--json']],
        ['/fake/tailscale', ['serve', 'status', '--json']],
      ])
      const checks = tailscaleChecks(found)
      expect(exitCodeFor(checks)).toBe(state === 'other' || state === 'funnel' ? 78 : 0)
      expect(checks[1]?.status).toBe(
        state === 'ours' ? 'pass' : state === 'other' || state === 'funnel' ? 'fail' : 'warn',
      )
      expect(setupTailscaleHint(found)).toEqual(
        state === 'absent' ? [`Port ${port}: Run phosphor tailscale enable.`] : [],
      )
      expect(JSON.stringify(checks)).not.toContain(name)
    },
  )
  it.each([
    { ...status, CertDomains: [] },
    { ...status, Self: { DNSName: 'BEE.tail123.ts.net.' } },
  ])('does not suggest enable without a usable certified name: %j', async (statusValue) => {
    const probe = vi.fn(async (_file: string, args: readonly string[]) =>
      result(args[0] === 'status' ? JSON.stringify(statusValue) : '{}'),
    )
    const found = await inspectTailscale(config, {}, 'linux', {
      which: async () => '/fake/tailscale',
      probe,
    })
    expect(found.readiness).toBe(statusValue.CertDomains.length === 0 ? 'no-https' : 'ok')
    expect(found.state).toBe('absent')
    expect(found.name).toBeNull()
    expect(setupTailscaleHint(found)).toEqual([])
  })
  it.each([
    'missing',
    'stopped',
    'invalid-name',
    'uncertified',
    'too-long',
    'truncated',
    'timeout',
    'error',
    'signal',
    'nonzero',
    'no-https',
    'serve-truncated',
  ] as const)('fails closed for %s', async (mode) => {
    const longName = `${'x'.repeat(63)}.${'y'.repeat(63)}.${'z'.repeat(63)}.${'a'.repeat(63)}.ts.net`
    const changed =
      mode === 'stopped'
        ? { ...status, BackendState: 'Stopped' }
        : mode === 'invalid-name'
          ? { ...status, Self: { DNSName: 'bee.example.com' } }
          : mode === 'uncertified' || mode === 'no-https'
            ? { ...status, CertDomains: [] }
            : mode === 'too-long'
              ? { ...status, Self: { DNSName: longName }, CertDomains: [longName] }
              : status
    const probe = vi.fn(async (_file: string, args: readonly string[]) =>
      result(
        args[0] === 'status'
          ? JSON.stringify(changed)
          : mode === 'too-long'
            ? JSON.stringify({
                TCP: route().TCP,
                Web: { [`${longName}:${port}`]: route().Web[`${name}:${port}`] },
              })
            : JSON.stringify(route()),
        {
          truncated: mode === 'truncated' || (mode === 'serve-truncated' && args[0] === 'serve'),
          timedOut: mode === 'timeout',
          ...(mode === 'error' ? { error: 'private' } : {}),
          signal: mode === 'signal' ? 'SIGKILL' : null,
          code: mode === 'nonzero' ? 1 : 0,
        },
      ),
    )
    const found = await inspectTailscale(config, {}, 'linux', {
      which: async () => (mode === 'missing' ? null : '/fake/tailscale'),
      probe,
    })
    expect(found.endpoint).toBeNull()
    if (mode === 'missing' || mode === 'stopped') {
      expect(tailscaleChecks(found)).toHaveLength(1)
      expect(exitCodeFor(tailscaleChecks(found))).toBe(0)
      expect(probe).toHaveBeenCalledTimes(mode === 'missing' ? 0 : 1)
    }
    expect(setupTailscaleHint(found)).toEqual([])
  })
})
