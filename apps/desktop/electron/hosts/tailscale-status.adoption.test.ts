import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  TAILSCALE_OPTIONS,
} from './tailscale-status'

const status = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: 'Running',
    CurrentTailnet: { MagicDNSEnabled: true, Name: 'private-tailnet' },
    CertDomains: ['self.tail123.ts.net'],
    Self: { PublicKey: 'private-key' },
    Peer: { privatePeer: { TailscaleIPs: ['100.1.2.3'] } },
    ...patch,
  })

function executableFiles(...paths: string[]): void {
  fileStat.mockImplementation(async (path: string) => {
    if (!paths.includes(path)) throw new Error('missing')
    return { isFile: () => true }
  })
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.stubEnv('PATH', '/inherited/bin')
  exec.mockReset()
  fileStat.mockReset()
  fileAccess.mockReset().mockResolvedValue(undefined)
  loginPath.mockReset().mockResolvedValue('/login/bin')
  executableFiles('/login/bin/tailscale')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Desktop Tailscale adoption contract', () => {
  it('prefers inherited executable files over login-shell and fixed candidates', async () => {
    executableFiles('/inherited/bin/tailscale', '/login/bin/tailscale', '/usr/local/bin/tailscale')
    expect(await resolveTailscaleExecutable()).toBe('/inherited/bin/tailscale')
    expect(loginPath).toHaveBeenCalledTimes(1)
  })

  it('uses the login shell when the inherited GUI PATH has no executable', async () => {
    expect(await resolveTailscaleExecutable()).toBe('/login/bin/tailscale')
  })

  it.each([
    ['darwin', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
    ['darwin', '/opt/homebrew/bin/tailscale'],
    ['linux', '/snap/bin/tailscale'],
  ] as const)('falls back to native %s install %s', async (platform, candidate) => {
    executableFiles(candidate)
    expect(await resolveTailscaleExecutable(platform, 'relative', async () => null)).toBe(candidate)
  })

  it('executes only status --json with bounded output and a five-second SIGKILL deadline', async () => {
    exec.mockImplementation((_file, _argv, _options, done) => done(null, status()))
    expect(await readTailscaleStatus()).toEqual({ code: 'ready' })
    expect(exec).toHaveBeenCalledWith(
      '/login/bin/tailscale',
      ['status', '--json'],
      {
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1_048_576,
        encoding: 'utf8',
        windowsHide: true,
      },
      expect.any(Function),
    )
  })

  it('distinguishes no installation from a resolved executable failing to launch', async () => {
    executableFiles()
    expect(await readTailscaleStatus()).toEqual({ code: 'not-installed' })
    expect(exec).not.toHaveBeenCalled()
    executableFiles('/login/bin/tailscale')
    exec.mockImplementation((_file, _argv, _options, done) => done({ code: 'ENOENT' }, 'private'))
    expect(await readTailscaleStatus()).toEqual({ code: 'check-failed' })
  })

  it('reports resolution failure without disclosing errors', async () => {
    loginPath.mockRejectedValue(new Error('private shell failure'))
    expect(await readTailscaleStatus()).toEqual({ code: 'check-failed' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('cancels the spawned child once at five seconds even if its pipes never close', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    exec.mockReturnValue({ kill })
    let settled: unknown
    const pending = readTailscaleStatus().then((value) => (settled = value))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(settled).toBeUndefined()
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toEqual({ code: 'check-failed' })
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    await vi.advanceTimersByTimeAsync(TAILSCALE_OPTIONS.timeout)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('never launches a late-resolving executable after the five-second deadline', async () => {
    vi.useFakeTimers()
    let finish: (path: string) => void = () => {}
    loginPath.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)))
    const pending = readTailscaleStatus()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toEqual({ code: 'check-failed' })
    finish('/login/bin')
    await vi.runAllTimersAsync()
    expect(exec).not.toHaveBeenCalled()
  })

  it.each([
    ['signed-out', { BackendState: 'NeedsLogin', CurrentTailnet: null }],
    ['signed-out', { BackendState: 'NeedsMachineAuth' }],
    ['not-running', { BackendState: 'Stopped' }],
    ['magicdns-unavailable', { CurrentTailnet: { MagicDNSEnabled: 'true' }, CertDomains: [] }],
    ['https-unavailable', { CertDomains: ['https://private.test'] }],
    ['ready', { CertDomains: [42, 'self.tail123.ts.net.'] }],
    ['check-failed', { BackendState: null }],
  ])('retains strict prerequisite precedence: %s', async (code, patch) => {
    const output = status(patch)
    expect(parseTailscaleStatus(output)).toEqual({ code })
    expect(await readTailscaleStatus((done) => done(null, output))).toEqual({ code })
  })

  it('returns only a fixed status and never logs private output or command errors', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => undefined),
    )
    expect(await readTailscaleStatus((done) => done(null, status()))).toEqual({ code: 'ready' })
    expect(await readTailscaleStatus((done) => done({ code: 'PRIVATE_ERROR' }, status()))).toEqual({
      code: 'check-failed',
    })
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON and output beyond the byte cap without exposing it', () => {
    for (const output of ['private-not-json', 'null', status({ padding: 'é'.repeat(524_288) })])
      expect(parseTailscaleStatus(output)).toEqual({ code: 'check-failed' })
  })
})
