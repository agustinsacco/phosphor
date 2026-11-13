import { scrubExcerpt } from './secrets'
import type { Citation, Proposal } from './types'

/** Sanitize the writer's own copy, leaving refs, ids and vectors intact. */
export function scrubProposal(value: Proposal): Proposal {
  const citation = (c: Citation): Citation => ({ ...c, quote: scrubExcerpt(c.quote) })
  return {
    ...value,
    origin: { ...value.origin, title: scrubExcerpt(value.origin.title) },
    entities: value.entities.map((item) => ({
      ...item,
      label: scrubExcerpt(item.label),
      aliases: item.aliases.map((name) => scrubExcerpt(name)),
      description: scrubExcerpt(item.description),
      reason: scrubExcerpt(item.reason),
    })),
    memories: value.memories.map((item) => ({
      ...item,
      summary: scrubExcerpt(item.summary),
      reason: scrubExcerpt(item.reason),
      citations: item.citations.map(citation),
      links: item.links.map((link) => ({ ...link, citation: citation(link.citation) })),
    })),
    evidence: value.evidence.map((item) => ({
      ...item,
      text: scrubExcerpt(item.text),
      label: scrubExcerpt(item.label),
    })),
    confirmations: value.confirmations.map((item) => ({
      ...item,
      citations: item.citations.map(citation),
    })),
    groups: value.groups.map((item) => ({
      ...item,
      parent: { ...item.parent, label: scrubExcerpt(item.parent.label) },
    })),
  }
}
