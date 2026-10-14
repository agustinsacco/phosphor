import { execFile } from 'node:child_process'
import type { TailscalePeer, TailscaleStatus } from '@shared/tailscale-status'

export const TAILSCALE_OPTIONS = {
  timeout: 5_000,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 1_048_576,
  encoding: 'utf8' as const,
  windowsHide: true,
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const dnsName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 254 &&
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net\.?$/i.test(value)

/** Tailscale's extensible JSON is untrusted. Only these fields leave main. */
export function parseTailscaleStatus(output: string, discovery: boolean): TailscaleStatus {
  const result = (code: TailscaleStatus['code'], peers: TailscalePeer[] = []): TailscaleStatus => ({
    code,
    discovery,
    peers,
  })
  if (Buffer.byteLength(output) > TAILSCALE_OPTIONS.maxBuffer) return result('check-failed')
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return result('check-failed')
  }
  if (!record(value) || typeof value.BackendState !== 'string') return result('check-failed')
  if (value.BackendState === 'NeedsLogin' || value.BackendState === 'NeedsMachineAuth')
    return result('signed-out')
  if (value.BackendState !== 'Running') return result('not-running')
  if (!record(value.CurrentTailnet) || value.CurrentTailnet.MagicDNSEnabled !== true)
    return result('magicdns-unavailable')
  if (!Array.isArray(value.CertDomains) || !value.CertDomains.some(dnsName))
    return result('https-unavailable')
  if (!discovery) return result('ready')
  if (!record(value.Peer) || Object.keys(value.Peer).length > 1_000) return result('check-failed')
  const peers: TailscalePeer[] = []
  for (const peer of Object.values(value.Peer)) {
    if (
      !record(peer) ||
      !dnsName(peer.DNSName) ||
      typeof peer.Online !== 'boolean' ||
      typeof peer.OS !== 'string'
    )
      continue
    peers.push({
      dnsName: peer.DNSName.toLowerCase().replace(/\.$/, ''),
      os: peer.OS === 'linux' || peer.OS === 'darwin' || peer.OS === 'windows' ? peer.OS : 'other',
      online: peer.Online,
    })
  }
  return result('ready', peers)
}

export type TailscaleRunner = (
  done: (error: { code?: string | number } | null, output: string) => void,
) => void | (() => void)
const run: TailscaleRunner = (done) => {
  const child = execFile('tailscale', ['status', '--json'], TAILSCALE_OPTIONS, (error, stdout) =>
    done(error, stdout),
  )
  return () => {
    child.kill('SIGKILL')
  }
}
export function readTailscaleStatus(
  discovery: boolean,
  runner: TailscaleRunner = run,
): Promise<TailscaleStatus> {
  return new Promise((resolve) => {
    const failure = (code: TailscaleStatus['code'] = 'check-failed'): TailscaleStatus => ({
      code,
      discovery,
      peers: [],
    })
    // execFile waits for stdio to close. Bound IPC even if a descendant holds a pipe open.
    const deadline = setTimeout(() => {
      resolve(failure())
      cancel?.()
    }, TAILSCALE_OPTIONS.timeout)
    const cancel = runner((error, output) => {
      clearTimeout(deadline)
      resolve(
        error
          ? failure(error.code === 'ENOENT' ? 'not-installed' : 'check-failed')
          : parseTailscaleStatus(output, discovery),
      )
    })
  })
}
