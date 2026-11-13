import type { LaneEntry } from '../transcript'
import type { StageExtraction } from '../stage-types'

export const LANE_ENTRIES: LaneEntry[] = [
  { type: 'session', id: 'harbor-lane', cwd: '/projects/harbor' },
  { type: 'model_change', id: 'model', provider: 'example', modelId: 'fast' },
  { type: 'thinking_level_change', id: 'thinking', thinkingLevel: 'high' },
  {
    type: 'message',
    id: 'user',
    timestamp: '2026-11-06T12:47:00Z',
    message: {
      role: 'user',
      content: 'Rina Okafor owns Harbor billing. Tom Lee reviews schema changes.',
    },
  },
  {
    type: 'message',
    id: 'agent',
    timestamp: '2026-11-06T12:48:00Z',
    message: {
      role: 'assistant',
      provider: 'example',
      model: 'fast',
      content: [
        { type: 'thinking' },
        { type: 'text', text: 'Checking the billing policy.\u2028Keep this together.' },
        { type: 'toolCall', name: 'bash', arguments: { command: 'cat harbor-policy.md' } },
      ],
    },
  },
  {
    type: 'message',
    id: 'tool',
    timestamp: '2026-11-06T12:49:00Z',
    message: {
      role: 'toolResult',
      toolName: 'bash',
      content: [{ type: 'text', text: 'Harbor retains invoices for seven years.' }],
    },
  },
  {
    type: 'compaction',
    id: 'summary',
    timestamp: '2026-11-06T12:50:00Z',
    summary: 'Harbor keeps invoice changes backwards compatible.',
  },
  { type: 'branch_summary', id: 'branch', summary: 'Tom Lee approved the invoice schema.' },
  {
    type: 'custom_message',
    id: 'custom',
    content: 'Harbor release policy is under review.',
  },
]
export const RAW_EXTRACTION: StageExtraction = {
  entities: [
    {
      ref: 'n1',
      label: 'Rina Okafor',
      kind: 'person',
      aliases: ['Rina'],
      description: 'Billing owner',
      keys: [],
    },
    {
      ref: 'n2',
      label: 'Harbor',
      kind: 'project',
      aliases: ['Harbor billing'],
      description: 'Billing project',
      keys: [],
    },
  ],
  claims: [
    {
      ref: 'c1',
      text: 'Rina Okafor owns Harbor billing.',
      type: 'fact',
      epistemic: 'reported',
      mentions: ['n1', 'n2'],
      links: [
        {
          subject: 'n1',
          predicate: 'owns',
          object: 'n2',
          segment: 's1',
          quote: 'Rina Okafor owns Harbor billing.',
        },
      ],
      quotes: [{ segment: 's1', quote: 'Rina Okafor owns Harbor billing.' }],
      validFrom: null,
      validTo: null,
      branch: false,
    },
  ],
  parents: [{ entity: 'n2', status: 'not_stated', claim: null }],
}
