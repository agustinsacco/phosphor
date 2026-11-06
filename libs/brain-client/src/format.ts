import type { BrainClaim, BrainEvidence } from '@phosphor/shared/brain'

/**
 * Brain text reaches a model as data with provenance, never as authority.
 * Everything inside the block is escaped, so stored text cannot close the
 * block or open a tag of its own.
 */
export type BrainDataSource = 'recall' | 'search' | 'read' | 'job'

export function escapeBrainText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function clipBrainText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

export function brainDataBlock(source: BrainDataSource, notice: string, lines: string[]): string {
  const body = [notice, ...lines].map(escapeBrainText).join('\n')
  return `<background-data source="phosphor-brain:${source}" authority="none">\n${body}\n</background-data>`
}

/** Adds whole groups while their escaped text fits; reports how many did not. */
export function fitBrainGroups(
  groups: string[][],
  maxChars: number,
): { lines: string[]; omitted: number } {
  const lines: string[] = []
  let used = 0
  let taken = 0
  for (const group of groups) {
    const size = group.reduce((total, line) => total + escapeBrainText(line).length + 1, 0)
    if (used + size > maxChars) break
    lines.push(...group)
    used += size
    taken += 1
  }
  return { lines, omitted: groups.length - taken }
}

function isoDay(at: number | null): string {
  return at === null ? '' : new Date(at).toISOString().slice(0, 10)
}

export function describeBrainClaim(claim: BrainClaim, summaryChars: number): string {
  const from = isoDay(claim.validFrom)
  const to = isoDay(claim.validTo)
  const valid = from || to ? `; valid ${from || '?'}..${to || 'now'}` : ''
  return `- ${clipBrainText(claim.summary, summaryChars)} [claim ${claim.id}; ${claim.kind}; ${claim.state}${valid}]`
}

export function describeBrainEvidence(evidence: BrainEvidence): string {
  const branch = evidence.branch ? `, branch ${evidence.branch}` : ''
  const observed = new Date(evidence.observedAt).toISOString()
  return `Evidence ${evidence.id}: ${evidence.role} in "${evidence.label}", observed ${observed}${branch}`
}
