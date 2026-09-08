/**
 * The `pidex-headroom` status key: cumulative compression savings pushed by
 * the bundled headroom extension (`pi-ext/headroom.ts`). Part of the status
 * wire contract in docs/extensions.md — the extension only pushes the key
 * once a result has actually been through the proxy, so a session with
 * Headroom off (or absent) never shows the section at all.
 */

export const HEADROOM_STATUS_KEY = 'pidex-headroom'

export interface HeadroomStatus {
  savedTokens: number
  beforeTokens: number
  afterTokens: number
  results: number
  skippedLossyTokens: number
  lastMs: number
}

export function parseHeadroomStatus(statusText: string | undefined): HeadroomStatus | null {
  if (!statusText) return null
  try {
    const raw = JSON.parse(statusText) as Record<string, unknown>
    const num = (key: string): number => (typeof raw[key] === 'number' ? (raw[key] as number) : 0)
    if (typeof raw.savedTokens !== 'number') return null
    return {
      savedTokens: num('savedTokens'),
      beforeTokens: num('beforeTokens'),
      afterTokens: num('afterTokens'),
      results: num('results'),
      skippedLossyTokens: num('skippedLossyTokens'),
      lastMs: num('lastMs'),
    }
  } catch {
    return null
  }
}
