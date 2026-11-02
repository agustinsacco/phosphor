import type { AgentFieldKey } from '@shared/machine-agent-behavior'

/**
 * What the Agent section calls each setting, on every machine. Ranges,
 * controls and pi's defaults live in `@shared/machine-agent-behavior`
 * (`AGENT_FIELDS`); search indexes these titles (`search/rows/agent.ts`).
 */
export interface AgentText {
  title: string
  description: string
  /** Search synonyms. */
  keywords: string
}

export const AGENT_FIELD_TEXT: Record<AgentFieldKey, AgentText> = {
  defaultThinkingLevel: {
    title: 'Default thinking level',
    description: 'How hard the model reasons before it answers, unless a lane picks its own.',
    keywords: 'reasoning effort',
  },
  hideThinkingBlock: {
    title: 'Hide thinking blocks',
    description: 'Collapse model reasoning out of the transcript.',
    keywords: 'reasoning collapse',
  },
  steeringMode: {
    title: 'Steering delivery',
    description: 'How queued steering messages are injected.',
    keywords: 'queue steer',
  },
  followUpMode: {
    title: 'Follow-up delivery',
    description: 'How queued follow-ups are injected.',
    keywords: 'queue followup',
  },
  'compaction.enabled': {
    title: 'Auto-compaction',
    description:
      'Compact context automatically near the window limit, or at the context budget below if that comes first.',
    keywords: 'summarize context window',
  },
  'compaction.reserveTokens': {
    title: 'Reserve tokens',
    description: "Headroom kept free for the model's response.",
    keywords: 'headroom response',
  },
  'compaction.keepRecentTokens': {
    title: 'Keep recent tokens',
    description: 'Recent conversation preserved verbatim during compaction.',
    keywords: 'verbatim',
  },
  'retry.enabled': {
    title: 'Retry on transient errors',
    description: 'Overloaded, rate-limit and 5xx responses.',
    keywords: 'overloaded rate limit 5xx',
  },
  'retry.maxRetries': {
    title: 'Max retries',
    description: 'Attempts before giving up.',
    keywords: 'attempts',
  },
  'retry.baseDelayMs': {
    title: 'Base delay (ms)',
    description: 'First retry delay; grows exponentially.',
    keywords: 'backoff',
  },
}

/** The rows that are not pi settings fields. */
export const AGENT_ROW_TEXT = {
  model: {
    title: 'Default model',
    description: 'The model a new lane starts on, unless it picks its own.',
    keywords: 'llm provider',
  },
  provider: {
    title: 'Provider id',
    description: 'A provider configured on this machine, e.g. "anthropic".',
    keywords: 'custom model',
  },
  modelId: {
    title: 'Model id',
    description: 'A model id that provider serves, e.g. "claude-sonnet-4-5".',
    keywords: 'custom model',
  },
  autoName: {
    title: 'Name new lanes automatically',
    description:
      'A one-shot model call titles a lane from its first message and renames its branch to match. Off keeps the first message as the title.',
    keywords: 'auto title rename session',
  },
  budget: {
    title: 'Context budget',
    description: '',
    keywords: 'window limit tokens compaction 200k',
  },
  instructions: {
    title: 'Global instructions',
    description: '',
    keywords: 'agents.md claude.md custom rules prompt edit markdown',
  },
} satisfies Record<string, AgentText>

/** The section's groups, in the order every machine shows them. */
export const AGENT_GROUPS = {
  lanes: { title: 'New lanes', keywords: 'default start' },
  behaviour: { title: 'Behaviour', keywords: 'behavior delivery queue' },
  compaction: { title: 'Compaction', keywords: 'summarize context' },
  retry: { title: 'Retry', keywords: 'auto-retry errors' },
  directives: { title: 'Instructions and directives', keywords: 'system prompt directives' },
} as const

/** Each group's pi settings fields, in order. */
export const AGENT_GROUP_FIELDS = {
  behaviour: ['hideThinkingBlock', 'steeringMode', 'followUpMode'],
  compaction: ['compaction.reserveTokens', 'compaction.keepRecentTokens'],
  retry: ['retry.enabled', 'retry.maxRetries', 'retry.baseDelayMs'],
} as const satisfies Record<string, readonly AgentFieldKey[]>
