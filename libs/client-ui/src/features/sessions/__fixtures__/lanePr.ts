import { prKey } from '@shared/github-pr-refs'
import type { GhPrSummary } from '@shared/models'
import type { LanePr } from '../lanePrs'
import { prVerdict } from '../prVerdict'

/** A lane's own PR as `resolveLanePrs` returns it, once read by number. */
export function lanePr(pr: GhPrSummary, patch: Partial<LanePr> = {}): LanePr {
  return {
    key: prKey(pr.ref),
    ref: pr.ref,
    number: pr.number,
    source: 'opened',
    pr,
    stale: false,
    verdict: prVerdict(pr),
    ...patch,
  }
}
