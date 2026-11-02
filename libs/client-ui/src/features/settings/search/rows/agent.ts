import type { AgentFieldKey } from '@shared/machine-agent-behavior'
import {
  AGENT_FIELD_TEXT,
  AGENT_GROUP_FIELDS,
  AGENT_GROUPS,
  AGENT_ROW_TEXT,
  type AgentText,
} from '../../sections/agent/agentFields'
import { section, type SettingEntry, type SettingRows } from '../settingEntry'

const row = ({ title, keywords }: AgentText): [string, string] => [title, keywords]
const fields = (keys: readonly AgentFieldKey[]): SettingRows =>
  keys.map((key) => row(AGENT_FIELD_TEXT[key]))
const group = (id: keyof typeof AGENT_GROUPS): [string, string] => [
  AGENT_GROUPS[id].title,
  AGENT_GROUPS[id].keywords,
]

/** Agent, from the field table the shared view renders, on every machine. */
export const AGENT_ROWS: SettingEntry[] = [
  ...section('agent', ['Agent defaults', 'default model thinking']),
  ...section('agent', group('lanes'), [
    row(AGENT_ROW_TEXT.model),
    row(AGENT_ROW_TEXT.provider),
    row(AGENT_ROW_TEXT.modelId),
    ...fields(['defaultThinkingLevel']),
    row(AGENT_ROW_TEXT.autoName),
  ]),
  ...section('agent', group('behaviour'), fields(AGENT_GROUP_FIELDS.behaviour)),
  ...section('agent', group('compaction'), [
    ...fields(['compaction.enabled']),
    row(AGENT_ROW_TEXT.budget),
    ...fields(AGENT_GROUP_FIELDS.compaction),
  ]),
  ...section('agent', group('retry'), fields(AGENT_GROUP_FIELDS.retry)),
  ...section('agent', group('directives'), [
    row(AGENT_ROW_TEXT.instructions),
    ['Worktree guard', 'branch checkout'],
    ['Machine awareness', 'host local remote tailscale machine prompt'],
    ['Lane charter', 'pull request pr'],
    ['Sub-agent policy', 'subagent delegation'],
  ]),
]
