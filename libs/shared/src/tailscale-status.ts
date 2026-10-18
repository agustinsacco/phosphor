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
}

export type TailscaleCertDomains =
  | { shape: 'missing' | 'null' | 'non-array' }
  | {
      shape: 'array'
      allStrings: boolean
      strings: string[]
      validDomains: string[]
    }

/** Only prerequisite facts; never includes Tailscale's Peer/Self metadata. */
export interface TailscaleFacts {
  backendState: string
  currentTailnetIsRecord: boolean
  magicDNSEnabled: boolean
  certDomains: TailscaleCertDomains
}

const STATUS_BYTE_CAP = 1_048_576
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const dnsName = (value: string): boolean =>
  value.length <= 254 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net\.?$/i.test(value)

/** Count UTF-8 without Node or an allocation proportional to untrusted output. */
function withinByteCap(output: string): boolean {
  let bytes = 0
  for (let index = 0; index < output.length; index++) {
    const point = output.codePointAt(index)!
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes > STATUS_BYTE_CAP) return false
    if (point > 0xffff) index++
  }
  return true
}

function readCertDomains(value: Record<string, unknown>): TailscaleCertDomains {
  if (!('CertDomains' in value)) return { shape: 'missing' }
  if (value.CertDomains === null) return { shape: 'null' }
  if (!Array.isArray(value.CertDomains)) return { shape: 'non-array' }
  const strings = value.CertDomains.filter((item): item is string => typeof item === 'string')
  return {
    shape: 'array',
    allStrings: strings.length === value.CertDomains.length,
    strings,
    validDomains: strings.filter(dnsName),
  }
}

/** Optional malformed fields remain facts, not a failed status read. */
export function readTailscaleStatus(output: string): TailscaleFacts | null {
  if (!withinByteCap(output)) return null
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return null
  }
  if (!record(value) || typeof value.BackendState !== 'string') return null
  const currentTailnetIsRecord = record(value.CurrentTailnet)
  return {
    backendState: value.BackendState,
    currentTailnetIsRecord,
    magicDNSEnabled: record(value.CurrentTailnet) && value.CurrentTailnet.MagicDNSEnabled === true,
    certDomains: readCertDomains(value),
  }
}

/** Canonical strict prerequisites, in Desktop's existing precedence order. */
export function classifyTailscale(facts: TailscaleFacts | null): TailscaleStatus {
  if (!facts) return { code: 'check-failed' }
  if (facts.backendState === 'NeedsLogin' || facts.backendState === 'NeedsMachineAuth')
    return { code: 'signed-out' }
  if (facts.backendState !== 'Running') return { code: 'not-running' }
  if (!facts.currentTailnetIsRecord || !facts.magicDNSEnabled)
    return { code: 'magicdns-unavailable' }
  if (facts.certDomains.shape !== 'array' || facts.certDomains.validDomains.length === 0)
    return { code: 'https-unavailable' }
  return { code: 'ready' }
}
