import { describe, expect, it, vi } from 'vitest'
import { parseTailscaleStatus } from '../../../apps/desktop/electron/hosts/tailscale-status'
import { tailscaleReadiness } from '../../../apps/host/src/machine/readiness'
import { PROBE_OUTPUT_CAP, type ProbeResult } from '../../../apps/host/src/machine/probe'
import type { Readiness } from './control-api'
import { classifyTailscale, readTailscaleStatus, type TailscaleFacts } from './tailscale-status'

const status = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: 'Running',
    CurrentTailnet: { MagicDNSEnabled: true },
    CertDomains: ['host.tail123.ts.net'],
    ...patch,
  })
const successfulProbe = (stdout: string, truncated = false): ProbeResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  truncated,
})

// Compatibility projection only: the Host adapter and its process cap stay unchanged.
function legacyHostProjection(facts: TailscaleFacts | null): Readiness['tailscale'] {
  if (!facts) return 'unknown'
  if (facts.backendState !== 'Running') return 'stopped'
  const certs = facts.certDomains
  if (certs.shape === 'missing' || certs.shape === 'null') return 'no-https'
  if (certs.shape !== 'array' || !certs.allStrings) return 'unknown'
  return certs.strings.length === 0 ? 'no-https' : 'ok'
}

const certCases: [string, unknown, TailscaleFacts['certDomains']][] = [
  ['missing', undefined, { shape: 'missing' }],
  ['null', null, { shape: 'null' }],
  ['string', 'host.ts.net', { shape: 'non-array' }],
  ['number', 4, { shape: 'non-array' }],
  ['boolean', false, { shape: 'non-array' }],
  ['record', { secret: 'private' }, { shape: 'non-array' }],
  ['empty array', [], { shape: 'array', allStrings: true, strings: [], validDomains: [] }],
  [
    'non-string array',
    [4, null, {}],
    { shape: 'array', allStrings: false, strings: [], validDomains: [] },
  ],
  [
    'mixed array',
    [4, 'host.ts.net', null, 'invalid', 'HOST.TS.NET.'],
    {
      shape: 'array',
      allStrings: false,
      strings: ['host.ts.net', 'invalid', 'HOST.TS.NET.'],
      validDomains: ['host.ts.net', 'HOST.TS.NET.'],
    },
  ],
  [
    'duplicates',
    ['host.ts.net', 'host.ts.net'],
    {
      shape: 'array',
      allStrings: true,
      strings: ['host.ts.net', 'host.ts.net'],
      validDomains: ['host.ts.net', 'host.ts.net'],
    },
  ],
]
const domainCases: [string, boolean][] = [
  ['host.ts.net', true],
  ['HOST.TAIL123.TS.NET.', true],
  ['a-b.ts.net', true],
  [`${'a'.repeat(63)}.ts.net`, true],
  [`${('a'.repeat(61) + '.').repeat(4)}ts.net`, true],
  [`${('a'.repeat(61) + '.').repeat(4)}ts.net.`, false],
  [`${'a'.repeat(64)}.ts.net`, false],
  ['', false],
  ['ts.net', false],
  ['-host.ts.net', false],
  ['host-.ts.net', false],
  ['host..ts.net', false],
  ['host.ts.net..', false],
  ['host.ts.net.evil', false],
  ['https://host.ts.net', false],
  ['host.example.com', false],
  [' host.ts.net', false],
  ['host.ts.net\n', false],
  ['höst.ts.net', false],
  ['*.ts.net', false],
]

describe('readTailscaleStatus facts', () => {
  it('returns exactly prerequisite facts and drops Peer/Self and unknown metadata', () => {
    expect(
      readTailscaleStatus(
        status({
          Self: { DNSName: 'secret.ts.net', PublicKey: 'secret', UserID: 42 },
          Peer: { key: { TailscaleIPs: ['100.1.2.3'], Tags: ['private'] } },
          CurrentTailnet: { MagicDNSEnabled: true, Name: 'private' },
          Unknown: { nested: 'private' },
        }),
      ),
    ).toEqual({
      backendState: 'Running',
      currentTailnetIsRecord: true,
      magicDNSEnabled: true,
      certDomains: {
        shape: 'array',
        allStrings: true,
        strings: ['host.tail123.ts.net'],
        validDomains: ['host.tail123.ts.net'],
      },
    })
  })
  it.each(certCases)('preserves certificate shape: %s', (_name, value, expected) => {
    const facts = readTailscaleStatus(status({ CertDomains: value }))
    expect(facts?.certDomains).toEqual(expected)
    expect(facts?.backendState).toBe('Running')
  })
  it.each(domainCases)('marks bounded Desktop domain %j as valid=%s', (domain, valid) => {
    expect(readTailscaleStatus(status({ CertDomains: [domain] }))?.certDomains).toEqual({
      shape: 'array',
      allStrings: true,
      strings: [domain],
      validDomains: valid ? [domain] : [],
    })
  })
  it.each([
    [undefined, false, false],
    [null, false, false],
    [[], false, false],
    ['tailnet', false, false],
    [true, false, false],
    [{}, true, false],
    [{ MagicDNSEnabled: false }, true, false],
    [{ MagicDNSEnabled: 'true' }, true, false],
    [{ MagicDNSEnabled: 1 }, true, false],
    [{ MagicDNSEnabled: true }, true, true],
  ])('preserves tailnet record and exact MagicDNS truth for %j', (tailnet, isRecord, enabled) => {
    const facts = readTailscaleStatus(status({ CurrentTailnet: tailnet }))
    expect(facts?.currentTailnetIsRecord).toBe(isRecord)
    expect(facts?.magicDNSEnabled).toBe(enabled)
  })
  it.each(['bad', 'null', '[]', '4', 'true', '"Running"', '{}', '{"BackendState":null}'])(
    'returns null for invalid JSON/top-level/backend: %s',
    (output) => expect(readTailscaleStatus(output)).toBeNull(),
  )
  it.each(['x', 'é', '€', '😀', '\ud800', '\udc00'])(
    'uses exact UTF-8 bytes for %j, including replacement of lone surrogates',
    (character) => {
      // Raw characters in a JSON string, not JSON.stringify's escaped lone surrogates.
      const base = status().slice(0, -1) + `,"padding":"${character.repeat(100)}"}`
      const output = base + ' '.repeat(1_048_576 - Buffer.byteLength(base))
      expect(readTailscaleStatus(output.slice(0, -1))).not.toBeNull()
      expect(readTailscaleStatus(output)).not.toBeNull()
      expect(readTailscaleStatus(output + ' ')).toBeNull()
      expect(classifyTailscale(readTailscaleStatus(output))).toEqual(parseTailscaleStatus(output))
      expect(classifyTailscale(readTailscaleStatus(output + ' '))).toEqual({ code: 'check-failed' })
    },
  )
  it('never logs valid or invalid untrusted input', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
    )
    try {
      readTailscaleStatus(status({ Self: { PublicKey: 'secret' } }))
      readTailscaleStatus('secret')
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('Tailscale fact projections', () => {
  it('reproduces both legacy classifiers across prerequisite combinations', () => {
    const certificates = [
      ...certCases.map(([, value]) => value),
      ...domainCases.map(([domain]) => [domain]),
    ]
    for (const BackendState of [
      'Running',
      'NeedsLogin',
      'NeedsMachineAuth',
      'Stopped',
      '',
      'Future',
      4,
      undefined,
    ]) {
      for (const CurrentTailnet of [
        undefined,
        null,
        [],
        {},
        { MagicDNSEnabled: false },
        { MagicDNSEnabled: 'true' },
        { MagicDNSEnabled: true },
      ]) {
        for (const CertDomains of certificates) {
          const output = status({ BackendState, CurrentTailnet, CertDomains })
          const facts = readTailscaleStatus(output)
          expect(classifyTailscale(facts)).toEqual(parseTailscaleStatus(output))
          expect(legacyHostProjection(facts)).toBe(tailscaleReadiness(successfulProbe(output)))
        }
      }
    }
  })
  it.each([
    ['NeedsLogin', null, 4, 'signed-out'],
    ['NeedsMachineAuth', null, 4, 'signed-out'],
    ['Stopped', null, 4, 'not-running'],
    ['Running', null, 4, 'magicdns-unavailable'],
    ['Running', { MagicDNSEnabled: true }, 4, 'https-unavailable'],
    ['Running', { MagicDNSEnabled: true }, [4, 'host.ts.net'], 'ready'],
  ])(
    'keeps strict precedence for %s / %j / %j',
    (BackendState, CurrentTailnet, CertDomains, code) => {
      expect(
        classifyTailscale(
          readTailscaleStatus(status({ BackendState, CurrentTailnet, CertDomains })),
        ),
      ).toEqual({ code })
    },
  )
  it('classifies null as check-failed', () => {
    expect(classifyTailscale(null)).toEqual({ code: 'check-failed' })
  })
  it('leaves the separate 64 KiB Host process cap to its adapter', () => {
    const base = status({ padding: 'é😀' })
    const output = base + ' '.repeat(PROBE_OUTPUT_CAP - Buffer.byteLength(base))
    expect(legacyHostProjection(readTailscaleStatus(output))).toBe('ok')
    expect(tailscaleReadiness(successfulProbe(output))).toBe('ok')
    expect(classifyTailscale(readTailscaleStatus(output + ' '))).toEqual({ code: 'ready' })
    expect(tailscaleReadiness(successfulProbe(output + ' ', true))).toBe('unknown')
  })
})
