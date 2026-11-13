import type { GhPrKey, GhPrRef, GhPrSummaryOptions } from './models'

/** Refs in one `gh:prSummaries` call. The renderer pages anything longer. */
export const PR_SUMMARY_BATCH_SIZE = 20

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[\w.-]{1,100}$/
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/
// In free text, only links that look like GitHub's own count: other forges
// also say `/pull/`. A URL GitHub itself returned is trusted by main instead.
const GITHUB_HOST = /(?:^|\.)github(?:[.-]|$)/
const URL_PATTERN =
  /https:\/\/([a-z0-9.-]+)\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([\w.-]{1,100})\/pull\/(\d{1,9})(?!\d)/gi

export const prKey = (ref: GhPrRef): GhPrKey =>
  `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase()

export const prUrl = (ref: GhPrRef): string =>
  `https://${ref.host}/${ref.owner}/${ref.repo}/pull/${ref.number}`

/** `#20246` in its own repo, `augment-dbt#1923` elsewhere. */
export function prLabel(ref: GhPrRef, homeRepo?: string): string {
  return homeRepo && ref.repo.toLowerCase() === homeRepo.toLowerCase()
    ? `#${ref.number}`
    : `${ref.repo}#${ref.number}`
}

export function isPrRef(value: unknown): value is GhPrRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return (
    Object.keys(ref).every((key) => ['host', 'owner', 'repo', 'number'].includes(key)) &&
    typeof ref.host === 'string' &&
    HOST.test(ref.host) &&
    typeof ref.owner === 'string' &&
    OWNER.test(ref.owner) &&
    typeof ref.repo === 'string' &&
    REPO.test(ref.repo) &&
    ref.repo !== '.' &&
    ref.repo !== '..' &&
    Number.isSafeInteger(ref.number) &&
    (ref.number as number) > 0
  )
}

function matches(text: string): GhPrRef[] {
  return [...text.matchAll(URL_PATTERN)].flatMap((match) => {
    const ref = {
      host: match[1]!.toLowerCase(),
      owner: match[2]!,
      repo: match[3]!,
      number: Number(match[4]),
    }
    return isPrRef(ref) ? [ref] : []
  })
}

/** Every GitHub PR link in `text`, in order, without repeats. */
export function prRefsIn(text: string, limit = 50): GhPrRef[] {
  if (!text.includes('/pull/')) return []
  const seen = new Set<string>()
  const refs: GhPrRef[] = []
  for (const ref of matches(text)) {
    if (!GITHUB_HOST.test(ref.host) || seen.has(prKey(ref))) continue
    seen.add(prKey(ref))
    refs.push(ref)
    if (refs.length >= limit) break
  }
  return refs
}

/** One PR link on any host: a URL GitHub returned, or one pasted into "Track a PR…". */
export function parsePrUrl(text: string): GhPrRef | null {
  const refs = matches(text.trim())
  return refs.length === 1 ? refs[0]! : null
}

/** IPC validation for `gh:prSummaries`: exact refs, no repeats, bounded. */
export function parsePrRefs(value: unknown): GhPrRef[] | null {
  if (!Array.isArray(value) || value.length > PR_SUMMARY_BATCH_SIZE) return null
  if (!value.every(isPrRef)) return null
  const keys = new Set(value.map(prKey))
  if (keys.size !== value.length) return null
  return value.map((ref) => ({ ...ref }))
}

export function parsePrSummaryOptions(value: unknown): GhPrSummaryOptions | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const options = value as Record<string, unknown>
  if (Object.keys(options).some((key) => key !== 'force')) return null
  if (options.force !== undefined && typeof options.force !== 'boolean') return null
  return options.force === undefined ? {} : { force: options.force }
}
