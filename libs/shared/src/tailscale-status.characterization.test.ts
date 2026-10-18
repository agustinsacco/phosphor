import { describe, expect, it, vi } from 'vitest'
import { parseTailscaleStatus } from '../../../apps/desktop/electron/hosts/tailscale-status'
import { tailscaleReadiness } from '../../../apps/host/src/machine/readiness'
import { PROBE_OUTPUT_CAP, type ProbeResult } from '../../../apps/host/src/machine/probe'
import type { Readiness } from './control-api'
import type { TailscaleCode } from './tailscale-status'

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
const cases: [string, Record<string, unknown>, TailscaleCode, Readiness['tailscale']][] = [
  ['running', {}, 'ready', 'ok'],
  [
    'needs login precedes prerequisites',
    { BackendState: 'NeedsLogin', CurrentTailnet: null, CertDomains: 4 },
    'signed-out',
    'stopped',
  ],
  ['needs machine auth', { BackendState: 'NeedsMachineAuth' }, 'signed-out', 'stopped'],
  [
    'stopped precedes prerequisites',
    { BackendState: 'Stopped', CurrentTailnet: null, CertDomains: 4 },
    'not-running',
    'stopped',
  ],
  ['unknown backend', { BackendState: 'FutureState' }, 'not-running', 'stopped'],
  ['non-string backend', { BackendState: 4 }, 'check-failed', 'unknown'],
  ['missing backend', { BackendState: undefined }, 'check-failed', 'unknown'],
  ['missing tailnet', { CurrentTailnet: undefined }, 'magicdns-unavailable', 'ok'],
  ['null tailnet', { CurrentTailnet: null }, 'magicdns-unavailable', 'ok'],
  ['array tailnet', { CurrentTailnet: [] }, 'magicdns-unavailable', 'ok'],
  ['missing MagicDNS', { CurrentTailnet: {} }, 'magicdns-unavailable', 'ok'],
  ['false MagicDNS', { CurrentTailnet: { MagicDNSEnabled: false } }, 'magicdns-unavailable', 'ok'],
  [
    'nonboolean MagicDNS',
    { CurrentTailnet: { MagicDNSEnabled: 'true' } },
    'magicdns-unavailable',
    'ok',
  ],
  [
    'MagicDNS precedes certificates',
    { CurrentTailnet: null, CertDomains: 4 },
    'magicdns-unavailable',
    'unknown',
  ],
  ['missing certificates', { CertDomains: undefined }, 'https-unavailable', 'no-https'],
  ['null certificates', { CertDomains: null }, 'https-unavailable', 'no-https'],
  ['non-array certificates', { CertDomains: 'host.ts.net' }, 'https-unavailable', 'unknown'],
  ['empty certificates', { CertDomains: [] }, 'https-unavailable', 'no-https'],
  ['mixed certificates', { CertDomains: [4, 'host.ts.net', null] }, 'ready', 'unknown'],
  ['only non-string certificates', { CertDomains: [4, null, {}] }, 'https-unavailable', 'unknown'],
  ['invalid domain string', { CertDomains: ['https://evil.test'] }, 'https-unavailable', 'ok'],
  ['empty domain string', { CertDomains: [''] }, 'https-unavailable', 'ok'],
  ['upper case and trailing dot', { CertDomains: ['HOST.TAIL123.TS.NET.'] }, 'ready', 'ok'],
  ['some valid domains', { CertDomains: ['bad', 'host.ts.net'] }, 'ready', 'ok'],
  ['bare suffix', { CertDomains: ['ts.net'] }, 'https-unavailable', 'ok'],
  ['leading hyphen', { CertDomains: ['-host.ts.net'] }, 'https-unavailable', 'ok'],
  ['trailing hyphen', { CertDomains: ['host-.ts.net'] }, 'https-unavailable', 'ok'],
  ['long label', { CertDomains: [`${'a'.repeat(64)}.ts.net`] }, 'https-unavailable', 'ok'],
  ['longest name', { CertDomains: [`${('a'.repeat(61) + '.').repeat(4)}ts.net`] }, 'ready', 'ok'],
  [
    'too long name',
    { CertDomains: [`${('a'.repeat(61) + '.').repeat(4)}ts.net.`] },
    'https-unavailable',
    'ok',
  ],
]

describe('legacy Tailscale projections', () => {
  it.each(cases)('%s', (_name, patch, desktop, host) => {
    const output = status(patch)
    expect(parseTailscaleStatus(output)).toEqual({ code: desktop })
    expect(tailscaleReadiness(successfulProbe(output))).toBe(host)
  })
  it.each(['bad JSON', 'null', '[]', '4', 'true', '"Running"', '{}'])(
    'rejects malformed or incomplete top-level input %s',
    (output) => {
      expect(parseTailscaleStatus(output)).toEqual({ code: 'check-failed' })
      expect(tailscaleReadiness(successfulProbe(output))).toBe('unknown')
    },
  )
  it.each(['x', 'é', '😀'])(
    'keeps distinct exact UTF-8 process caps with %s padding',
    (character) => {
      for (const cap of [PROBE_OUTPUT_CAP, 1_048_576]) {
        const base = status({ padding: character.repeat(100) })
        const output = base + ' '.repeat(cap - Buffer.byteLength(base))
        expect(Buffer.byteLength(output)).toBe(cap)
        expect(parseTailscaleStatus(output)).toEqual({ code: 'ready' })
        expect(parseTailscaleStatus(output + ' ')).toEqual({
          code: cap === 1_048_576 ? 'check-failed' : 'ready',
        })
        if (cap === PROBE_OUTPUT_CAP) {
          expect(tailscaleReadiness(successfulProbe(output))).toBe('ok')
          expect(tailscaleReadiness(successfulProbe(output + ' ', true))).toBe('unknown')
        }
      }
    },
  )
  it('returns no Peer/Self secrets and never logs untrusted output', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
    )
    try {
      const output = status({
        Peer: { key: { PublicKey: 'secret', TailscaleIPs: ['100.1.2.3'] } },
        Self: { DNSName: 'secret.ts.net', UserID: 42 },
        CurrentTailnet: { MagicDNSEnabled: true, Name: 'secret' },
      })
      expect(parseTailscaleStatus(output)).toEqual({ code: 'ready' })
      expect(tailscaleReadiness(successfulProbe(output))).toBe('ok')
      expect(parseTailscaleStatus('secret')).toEqual({ code: 'check-failed' })
      expect(tailscaleReadiness(successfulProbe('secret'))).toBe('unknown')
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
