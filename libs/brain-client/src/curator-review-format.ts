import type { BrainReadReview } from '@phosphor/shared/brain-agent'
import type {
  BrainIdentity,
  BrainProposalView,
  BrainProposedMemory,
} from '@phosphor/shared/brain-review'
import { compose, data, dataRoom } from './curator-format'
import { clip } from './format'

function identityLine(identity: BrainIdentity): string {
  const as =
    identity.decision === 'reuse' && identity.entityId ? ` as entity ${identity.entityId}` : ''
  const required = identity.required ? ' · REQUIRED' : ''
  const description = identity.description ? ` · ${data(identity.description, 200)}` : ''
  const candidates = identity.candidates
    .map(
      (c) =>
        `${c.id} = ${data(c.label, 120)} (${c.kind}${c.description ? `, ${data(c.description, 160)}` : ''})`,
    )
    .join('; ')
  return `- ${identity.ref} · ${data(identity.label, 120)} (${identity.kind}) · ${identity.decision}${as}${required}${description} · candidates: ${candidates || 'none'} · ${data(identity.reason, 300)}`
}

function memoryLine(memory: BrainProposedMemory): string {
  const target = memory.target
    ? ` memory ${memory.target.id} ("${data(memory.target.summary, 200)}")`
    : ''
  const held = memory.hold ? ` · HELD (${memory.hold}): saved only if you list it` : ''
  const quote = memory.quotes[0] ? ` · quote "${data(memory.quotes[0].quote, 240)}"` : ''
  return `- ${memory.index} · ${memory.type} · ${memory.action}${target}${held} · ${data(memory.summary, 600)} · names ${memory.entities.join(', ') || 'none'}${quote}`
}

type Section = 'identities' | 'groups' | 'memories' | 'confirmations'
const SECTIONS: [Section, { name: string; header: string }][] = [
  [
    'identities',
    {
      name: 'Identities',
      header:
        'Identities (identities: { ref: entity id or "new" }; unanswered ones keep Brain’s decision):',
    },
  ],
  ['groups', { name: 'Groups', header: 'Groups (list the indexes you confirm in groups):' }],
  ['memories', { name: 'Memories', header: 'Memories (indexes for memories):' }],
  [
    'confirmations',
    {
      name: 'Said again',
      header: 'Said again (saved with any approval; held ones only if listed in confirmations):',
    },
  ],
]
const SECTION = new Map(SECTIONS)
interface Item {
  section: Section
  line: string
}

/** Everything a review asks or proposes, in reading order: what `offset` counts. */
function reviewItems(p: BrainProposalView): Item[] {
  return [
    ...p.identities.map((i): Item => ({ section: 'identities', line: identityLine(i) })),
    ...p.groups.map((g): Item => ({
      section: 'groups',
      line: `- ${g.index} · are ${data(g.labels.join(', '), 300)} part of one ${data(g.parent.label, 120)} (${g.parent.kind})?`,
    })),
    ...p.memories.map((m): Item => ({ section: 'memories', line: memoryLine(m) })),
    ...p.confirmations.map((c, index): Item => ({
      section: 'confirmations',
      line: `- ${index} · memory ${c.id} · ${data(c.summary || c.claim.summary, 400)}${c.claim.hold ? ` · HELD (${c.claim.hold})` : ''}`,
    })),
  ]
}

/** The items from `start` that fit in `room`, each section's header before its first one. */
function page(items: Item[], start: number, room: number): { lines: string[]; end: number } {
  const lines: string[] = []
  let end = start
  for (; end < items.length; end++) {
    const item = items[end]!
    const opens = end === start || items[end - 1]!.section !== item.section
    const header = opens ? [SECTION.get(item.section)!.header] : []
    const headerCost = header.reduce((sum, line) => sum + line.length + 1, 0)
    if (headerCost + item.line.length + 1 > room) {
      if (lines.length) break
      // A line longer than a page is clipped, so every page moves on.
      lines.push(...header, clip(item.line, Math.max(1, room - headerCost - 1)))
      return { lines, end: end + 1 }
    }
    lines.push(...header, item.line)
    room -= headerCost + item.line.length + 1
  }
  return { lines, end }
}

/** "Memories 41–80 of 100" for each section the page shows, then where to go on. */
function pageLine(items: Item[], start: number, end: number): string {
  const shown = SECTIONS.flatMap(([section, { name }]) => {
    const first = items.findIndex((item) => item.section === section)
    if (first < 0) return []
    const total = items.filter((item) => item.section === section).length
    const from = Math.max(start, first) - first + 1
    const to = Math.min(end, first + total) - first
    return from <= to ? [`${name} ${from}–${to} of ${total}`] : []
  })
  const next =
    end < items.length ? `Call again with offset ${end}.` : 'That is the end of this read.'
  return `${shown.join('; ') || 'Nothing on this page'}. ${next}`
}

/**
 * A read's proposal: what Brain Agent must answer, then what approving saves. A long read is
 * paged: `offset` is where the previous page said to go on, counted across identities, groups,
 * memories and "said again" in that order.
 */
export function formatReview(review: BrainReadReview, offset = 0): string {
  const p = review.proposal
  const required = p.identities.filter((identity) => identity.required)
  const head = [
    `Read ${p.job.id} · "${data(p.job.title || 'Untitled lane', 120)}" · revision ${p.revision}.`,
    review.neverRead
      ? `Brain never reads this lane: reject it with brain_decide_read { jobId: "${p.job.id}", revision: ${p.revision}, approve: false, reason }.`
      : `Decide with brain_decide_read { jobId: "${p.job.id}", revision: ${p.revision}, approve, reason }. Approving saves every memory that is not held, on every page, unless you pass memories.`,
    ...(required.length
      ? [
          `Answer before approving: ${required.map((i) => i.ref).join(', ')} (in identities, an entity id or "new").`,
        ]
      : []),
    ...(p.replacingMemories
      ? [`Approving replaces ${p.replacingMemories} earlier memories from this lane.`]
      : []),
    ...(p.held ? [`${p.held} more claims were over this read's budget and are not proposed.`] : []),
  ]
  const items = reviewItems(p)
  const start = Math.min(Math.max(0, Math.trunc(offset)), items.length)
  const { lines, end } = page(items, start, dataRoom(head))
  const paged = start > 0 || end < items.length
  return compose(head, lines, () => (paged ? pageLine(items, start, end) : null))
}
