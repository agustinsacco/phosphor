import { beforeEach, describe, expect, it, vi } from 'vitest'
const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: exec }))
import { parseTailscaleStatus, readTailscaleStatus } from './tailscale-status'

const peer = {
  DNSName: 'bee.tail123.ts.net.',
  OS: 'linux',
  Online: true,
  TailscaleIPs: ['100.1.2.3'],
  PublicKey: 'secret',
  UserID: 42,
  Tags: ['private'],
}
const status = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: 'Running',
    CurrentTailnet: { MagicDNSEnabled: true, Name: 'private' },
    CertDomains: ['self.tail123.ts.net'],
    Peer: { key: peer },
    ...patch,
  })
beforeEach(() => {
  exec.mockReset()
})
describe('Tailscale read-only boundary', () => {
  it('executes only fixed argv without a shell and bounds time and output', async () => {
    exec.mockImplementation((_file, _argv, _options, done) => done(null, status()))
    await readTailscaleStatus(false)
    expect(exec).toHaveBeenCalledWith(
      'tailscale',
      ['status', '--json'],
      { timeout: 5000, maxBuffer: 1048576, encoding: 'utf8', windowsHide: true },
      expect.any(Function),
    )
  })
  it('projects only DNS, allowlisted OS and online; no private data', () => {
    expect(parseTailscaleStatus(status(), true)).toEqual({
      code: 'ready',
      discovery: true,
      peers: [{ dnsName: 'bee.tail123.ts.net', os: 'linux', online: true }],
    })
    expect(
      parseTailscaleStatus(status({ Peer: { key: { ...peer, OS: 'private distro' } } }), true)
        .peers[0]?.os,
    ).toBe('other')
  })
  it('never logs status output or errors', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
    )
    try {
      await readTailscaleStatus(true, (done) => done(null, status()))
      await readTailscaleStatus(true, (done) => done({ code: 'SECRET' }, 'secret output'))
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
  it('never returns peers without explicit discovery', () => {
    expect(parseTailscaleStatus(status(), false)).toEqual({
      code: 'ready',
      discovery: false,
      peers: [],
    })
  })
  it.each([
    ['signed-out', { BackendState: 'NeedsLogin' }],
    ['signed-out', { BackendState: 'NeedsMachineAuth' }],
    ['not-running', { BackendState: 'Stopped' }],
    ['magicdns-unavailable', { CurrentTailnet: { MagicDNSEnabled: false } }],
    ['magicdns-unavailable', { CurrentTailnet: { MagicDNSEnabled: 'true' } }],
    ['https-unavailable', { CertDomains: [] }],
    ['https-unavailable', { CertDomains: ['https://evil.test'] }],
    ['check-failed', { BackendState: 1 }],
    ['check-failed', { Peer: [] }],
  ])('maps prerequisites to fixed code %s', (code, patch) => {
    expect(parseTailscaleStatus(status(patch), true)).toEqual({ code, discovery: true, peers: [] })
  })
  it('rejects malformed JSON, oversized output and excessive peer counts', () => {
    for (const output of [
      'no JSON',
      'null',
      status({ padding: 'x'.repeat(1048576) }),
      status({ Peer: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [i, peer])) }),
    ])
      expect(parseTailscaleStatus(output, true).code).toBe('check-failed')
  })
  it.each([
    { DNSName: '-option.tail123.ts.net' },
    { DNSName: '100.1.2.3' },
    { DNSName: 'bee.tail123.ts.net;evil' },
    { DNSName: 'x'.repeat(255) },
    { DNSName: `${('a'.repeat(61) + '.').repeat(5)}ts.net` },
    { Online: 'yes' },
    { OS: null },
  ])('skips invalid peer fields %j', (patch) => {
    expect(
      parseTailscaleStatus(status({ Peer: { key: { ...peer, ...patch } } }), true).peers,
    ).toEqual([])
  })
  it.each([
    ['ENOENT', 'not-installed'],
    ['ETIMEDOUT', 'check-failed'],
    ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'check-failed'],
    [1, 'check-failed'],
  ])('never forwards command errors or output %s', async (code, expected) => {
    const result = await readTailscaleStatus(true, (done) => done({ code }, 'secret output'))
    expect(result).toEqual({ code: expected, discovery: true, peers: [] })
  })
})
