import { isIP } from 'node:net'

/**
 * The rate-limit subject for a peer address. A single IPv6 subscriber usually holds
 * a whole /64, so every address and spelling inside one /64 maps to one key. An
 * IPv4-mapped IPv6 address is its IPv4 address; IPv4 is unchanged. Anything that is
 * not an IP address maps to `unknown`, the subject used when there is no socket.
 */
export function ipRateKey(address: string): string {
  const family = isIP(address)
  if (family === 4) return address
  const groups = family === 6 ? ipv6Groups(address) : null
  if (!groups) return 'unknown'
  const [a, b, c, d, e, f, g, h] = groups
  if (g !== undefined && h !== undefined && [a, b, c, d, e].every((x) => x === 0) && f === 0xffff)
    return [g >> 8, g & 0xff, h >> 8, h & 0xff].join('.')
  return `${[a, b, c, d].map((group) => group?.toString(16)).join(':')}::/64`
}

/** The eight 16-bit groups of an address `isIP` accepted as IPv6, zone id dropped. */
function ipv6Groups(address: string): number[] | null {
  const [head = '', tail] = (address.split('%')[0] ?? '').split('::')
  const left = hextets(head)
  const right = tail === undefined ? [] : hextets(tail)
  const zeros = tail === undefined ? 0 : Math.max(0, 8 - left.length - right.length)
  const groups = [...left, ...Array<number>(zeros).fill(0), ...right]
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : null
}

/** Colon-separated groups; an embedded dotted IPv4 tail is two groups. Bad input is NaN. */
function hextets(part: string): number[] {
  if (!part) return []
  return part.split(':').flatMap((group) => {
    if (!group.includes('.')) return [Number('0x' + group)]
    const [a = NaN, b = NaN, c = NaN, d = NaN] = group.split('.').map(Number)
    return [a * 256 + b, c * 256 + d]
  })
}
