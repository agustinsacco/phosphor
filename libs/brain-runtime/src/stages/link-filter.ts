import type { BrainExtractionOutcome, BrainPredicate } from '@phosphor/shared/brain'
import type { Registry, StageExtraction, StageLink } from '../stage-types'
import { userEntity } from '../stage-owner'

/** The prompt forbids these on the user; the filter enforces it. */
const NEVER_FROM_USER: readonly BrainPredicate[] = ['uses', 'prefers']
const FROM_USER = 'The user is never linked to something they only use or prefer'
const OWNS_SAYS_IT = 'Owns already says this: works_on for the same pair is dropped'

/**
 * Deterministic link rules over one part's extract and links answers: no uses or prefers link
 * from the user, and owns plus works_on for one pair in one claim keeps only owns. Each dropped
 * link is an outcome named after its claim and its index there.
 */
export function filterLinks(extraction: StageExtraction, registry: Registry): StageExtraction {
  const user = userEntity(extraction.entities, registry)?.ref
  const labels = new Map([...registry, ...extraction.entities].map((e) => [e.ref, e.label]))
  const outcomes: BrainExtractionOutcome[] = []
  const reason = (link: StageLink, owned: Set<string>): string | null => {
    if (link.subject === user && NEVER_FROM_USER.includes(link.predicate)) return FROM_USER
    if (link.predicate === 'works_on' && owned.has(`${link.subject}|${link.object}`))
      return OWNS_SAYS_IT
    return null
  }
  const claims = extraction.claims.map((claim) => {
    const owned = new Set(
      claim.links.filter((l) => l.predicate === 'owns').map((l) => `${l.subject}|${l.object}`),
    )
    const links = claim.links.filter((link, index) => {
      const why = reason(link, owned)
      if (why)
        outcomes.push({
          candidate: `${claim.ref}:link-filter:${index + 1}`,
          summary: `${labels.get(link.subject) ?? link.subject} ${link.predicate} ${labels.get(link.object) ?? link.object}`,
          status: 'dropped',
          reason: why,
        })
      return !why
    })
    return links.length === claim.links.length ? claim : { ...claim, links }
  })
  if (!outcomes.length) return extraction
  return { ...extraction, claims, outcomes: [...(extraction.outcomes ?? []), ...outcomes] }
}
