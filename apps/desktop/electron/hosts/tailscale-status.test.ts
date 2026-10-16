import { beforeEach, describe, expect, it, vi } from 'vitest'
const { exec, fileStat, fileAccess, loginPath } = vi.hoisted(() => ({
  exec: vi.fn(),
  fileStat: vi.fn(),
  fileAccess: vi.fn(),
  loginPath: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execFile: exec }))
vi.mock('node:fs/promises', () => ({ stat: fileStat, access: fileAccess }))
vi.mock('../pi/shell-env', () => ({ getLoginShellPath: loginPath }))
import {
  parseTailscaleStatus,
  readTailscaleStatus,
  resolveTailscaleExecutable,
} from './tailscale-status'

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
  loginPath.mockResolvedValue('/login/bin')
  fileStat.mockReset().mockImplementation(async (path) => {
    if (path !== '/login/bin/tailscale') throw new Error('missing')
    return { isFile: () => true }
  })
  fileAccess.mockReset().mockResolvedValue(undefined)
})
describe('Tailscale read-only boundary', () => {
  it('executes only fixed argv without a shell and bounds time and output', async () => {
    exec.mockImplementation((_file, _argv, _options, done) => done(null, status()))
    await readTailscaleStatus(false)
    expect(exec).toHaveBeenCalledWith(
      '/login/bin/tailscale',
      ['status', '--json'],
      {
        timeout: 5000,
        killSignal: 'SIGKILL',
        maxBuffer: 1048576,
        encoding: 'utf8',
        windowsHide: true,
      },
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

describe('Tailscale executable resolution', () => {
  it('uses the login PATH even when the inherited GUI PATH has no CLI', async () => {
    expect(await resolveTailscaleExecutable('darwin', '/usr/bin:/bin')).toBe('/login/bin/tailscale')
  })
  it.each([
    ['darwin', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
    ['darwin', '/usr/local/bin/tailscale'],
    ['darwin', '/opt/homebrew/bin/tailscale'],
    ['linux', '/usr/bin/tailscale'],
    ['linux', '/usr/local/bin/tailscale'],
    ['linux', '/snap/bin/tailscale'],
  ] as const)('finds native %s installs with no usable PATH: %s', async (platform, candidate) => {
    fileStat.mockImplementation(async (path) => {
      if (path !== candidate) throw new Error('missing')
      return { isFile: () => true }
    })
    expect(await resolveTailscaleExecutable(platform, '/missing', async () => null)).toBe(candidate)
  })
  it('refuses relative, nonexistent, directory and nonexecutable candidates', async () => {
    const checked: string[] = []
    fileStat.mockImplementation(async (path: string) => {
      checked.push(path)
      if (path.startsWith('/missing')) throw new Error('missing')
      return { isFile: () => !path.startsWith('/directory') }
    })
    fileAccess.mockRejectedValue(new Error('not executable'))
    expect(
      await resolveTailscaleExecutable(
        'darwin',
        'relative:/missing:/directory:/denied',
        async () => '.',
      ),
    ).toBeNull()
    expect(checked.every((path) => path.startsWith('/'))).toBe(true)
    expect(fileAccess).not.toHaveBeenCalledWith('/directory/tailscale', expect.anything())
  })
  it('returns ready with peers using a resolved native candidate', async () => {
    loginPath.mockResolvedValue(null)
    const candidate = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    fileStat.mockImplementation(async (path) => {
      if (path !== candidate) throw new Error('missing')
      return { isFile: () => true }
    })
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    exec.mockImplementation((_file, _argv, _options, done) => done(null, status()))
    try {
      expect(await readTailscaleStatus(true)).toEqual({
        code: 'ready',
        discovery: true,
        peers: [{ dnsName: 'bee.tail123.ts.net', os: 'linux', online: true }],
      })
      expect(exec.mock.calls[0]?.[0]).toBe(candidate)
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('reports not-installed only when no executable resolves', async () => {
    fileStat.mockRejectedValue(new Error('missing'))
    expect(await readTailscaleStatus(true)).toEqual({
      code: 'not-installed',
      discovery: true,
      peers: [],
    })
    expect(exec).not.toHaveBeenCalled()
  })
  it('reports check-failed if a resolved executable cannot start', async () => {
    exec.mockImplementation((_file, _argv, _options, done) => done({ code: 'ENOENT' }, ''))
    expect((await readTailscaleStatus(true)).code).toBe('check-failed')
  })
  it('bounds resolution and never spawns after the deadline', async () => {
    vi.useFakeTimers()
    let finish: (path: string) => void = () => {}
    loginPath.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    try {
      const reading = readTailscaleStatus(true)
      await vi.advanceTimersByTimeAsync(5000)
      expect((await reading).code).toBe('check-failed')
      finish('/login/bin')
      await vi.runAllTimersAsync()
      expect(exec).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
