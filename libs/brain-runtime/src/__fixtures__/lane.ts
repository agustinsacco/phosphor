import type { LaneEntry } from '../transcript'
import type { RawExtraction } from '@phosphor/memory-engine/types'

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
export const RAW_EXTRACTION: RawExtraction = {
  summary: 'Harbor billing ownership was clarified.',
  entities: [
    { key: 'rina', label: 'Rina Okafor', kind: 'person', aliases: ['Rina'] },
    { key: 'harbor', label: 'Harbor', kind: 'project', aliases: ['Harbor billing'] },
  ],
  memories: [
    {
      subject: 'rina',
      predicate: 'owns',
      object: 'harbor',
      literal: null,
      summary: 'Rina Okafor owns Harbor billing.',
      kind: 'reported',
      type: 'fact',
      branch: false,
      validFrom: null,
      quotes: ['Rina Okafor owns Harbor billing.'],
      supersedes: null,
    },
  ],
}
