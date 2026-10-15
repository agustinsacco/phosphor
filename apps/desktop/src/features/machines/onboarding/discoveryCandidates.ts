import type { TailscalePeer } from '@shared/tailscale-status'

/** Endpoint hostnames alone suppress enrolled peers; labels are not identities. */
export function discoveryCandidates(
  peers: readonly TailscalePeer[],
  machines: readonly { endpoint: string | null }[],
): TailscalePeer[] {
  const enrolled = new Set(
    machines.flatMap(({ endpoint }) => {
      try {
        return endpoint ? [new URL(endpoint).hostname.toLowerCase().replace(/\.$/, '')] : []
      } catch {
        return []
      }
    }),
  )
  const seen = new Set<string>()
  return peers.filter((peer) => {
    if (!peer.online || enrolled.has(peer.dnsName) || seen.has(peer.dnsName)) return false
    seen.add(peer.dnsName)
    return true
  })
}
