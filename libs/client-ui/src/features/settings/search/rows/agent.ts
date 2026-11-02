import { LOCAL_ONLY, onHost, section, type SettingEntry } from '../settingEntry'

/** Agent: This Mac's rows, until a view every machine shares renders them. */
export const AGENT_ROWS: SettingEntry[] = [
  ...section(
    'agent',
    'Agent defaults',
    [
      ['Scope', 'global project workspace override'],
      ['Default model', 'llm'],
      'Default provider',
      ['Default thinking level', 'reasoning effort'],
      ['Hide thinking blocks', 'reasoning collapse'],
      ['Steering delivery', 'queue steer'],
      ['Follow-up delivery', 'queue followup'],
    ],
    LOCAL_ONLY,
  ),
  ...section(
    'agent',
    ['Compaction', 'summarize context'],
    [
      ['Auto-compaction', 'summarize context window'],
      ['Reserve tokens', 'headroom response'],
      ['Keep recent tokens', 'verbatim'],
    ],
    LOCAL_ONLY,
  ),
  ...section('agent', ['Context budget', 'window limit tokens compaction 200k'], [], LOCAL_ONLY),
  ...section(
    'agent',
    'Auto-retry',
    [
      ['Retry on transient errors', 'overloaded rate limit 5xx'],
      ['Max retries', 'attempts'],
      ['Base delay (ms)', 'backoff'],
    ],
    LOCAL_ONLY,
  ),
  ...section(
    'agent',
    ['Directives', 'system prompt instructions'],
    [
      ['Global instructions', 'agents.md claude.md custom rules prompt edit markdown'],
      ['Worktree guard', 'branch checkout'],
      ['Machine awareness', 'host local remote tailscale machine prompt'],
      ['Lane charter', 'pull request pr'],
      ['Sub-agent policy', 'subagent delegation'],
    ],
    LOCAL_ONLY,
  ),
]

/** The Host's Agent panel, by the heading it renders. */
export const AGENT_HOST_HEADING: SettingEntry[] = onHost('agent', [
  'Agent defaults',
  'Host default model thinking',
])
