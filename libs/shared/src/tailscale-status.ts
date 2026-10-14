/** Deliberately excludes addresses, identities, keys and tailnet metadata. */
export interface TailscalePeer {
  dnsName: string
  os: 'linux' | 'darwin' | 'windows' | 'other'
  online: boolean
}
export type TailscaleCode =
  | 'ready'
  | 'not-installed'
  | 'not-running'
  | 'signed-out'
  | 'magicdns-unavailable'
  | 'https-unavailable'
  | 'check-failed'
export interface TailscaleStatus {
  code: TailscaleCode
  discovery: boolean
  peers: TailscalePeer[]
}
