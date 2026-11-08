import { randomBytes } from 'node:crypto'
import type {
  LaneMoveNotice,
  LaneSourceFacts,
  LaneTargetPlan,
} from '@phosphor/shared/host-protocol-lane-transfer'

/** The `customType` of the entry a move appends. Clients render it as a plain notice. */
export const LANE_MOVED_TYPE = 'phosphor-lane-moved'

export interface NoticeInput {
  labels: LaneMoveNotice
  source: LaneSourceFacts
  plan: LaneTargetPlan
  cwd: string
  attachments: { from: string; to: string }[]
  at: Date
}

/**
 * The fixed text the agent reads first after a move. Written by Phosphor from
 * the facts of the move, never by a model, and only states what changed.
 */
export function noticeText(input: NoticeInput): string {
  const { labels, source, plan, cwd } = input
  const date = input.at.toISOString().slice(0, 10)
  const lines = [
    `Phosphor moved this lane from ${labels.from} (${source.workspace}, ${source.cwd}) to ${labels.to} (${plan.workspace}, ${cwd}) on ${date}.`,
  ]
  if (plan.mode === 'same-workspace' && source.git)
    lines.push(
      `Branch ${plan.branch} is checked out here at ${source.git.commit.slice(0, 12)}, the same commit as before.`,
    )
  else if (plan.mode === 'new-branch')
    lines.push(
      `This is a different workspace, so the code from the old one is not here. Branch ${plan.branch} was created here from the default branch.`,
    )
  else lines.push('This is a different folder. Files from the old folder did not move.')
  lines.push('Paths earlier in this conversation point to the old location.')
  if (input.attachments.length)
    lines.push(
      'Attached files are now at:',
      ...input.attachments.map((a) => `- ${a.from} → ${a.to}`),
    )
  lines.push('Continue from here.')
  return lines.join('\n')
}

/** The JSONL line for the notice, chained after `parentId` the way pi appends its own entries. */
export function noticeEntry(
  text: string,
  parentId: string | null,
  at: Date,
  attachments: { from: string; to: string }[] = [],
): string {
  return JSON.stringify({
    type: 'custom_message',
    customType: LANE_MOVED_TYPE,
    content: text,
    details: { attachments },
    display: true,
    id: randomBytes(4).toString('hex'),
    parentId,
    timestamp: at.toISOString(),
  })
}
