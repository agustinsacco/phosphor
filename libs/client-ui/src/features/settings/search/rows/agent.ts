import type { AgentFieldKey } from '@shared/machine-agent-behavior'
import {
  AGENT_FIELD_TEXT,
  AGENT_GROUP_FIELDS,
  AGENT_GROUPS,
  AGENT_ROW_TEXT,
  type AgentText,
} from '../../sections/agent/agentFields'
import { LOCAL_ONLY, section, type SettingEntry, type SettingRows } from '../settingEntry'

const row = ({ title, keywords }: AgentText): [string, string] => [title, keywords]
const fields = (keys: readonly AgentFieldKey[]): SettingRows =>
  keys.map((key) => row(AGENT_FIELD_TEXT[key]))
const group = (id: keyof typeof AGENT_GROUPS): [string, string] => [
  AGENT_GROUPS[id].title,
  AGENT_GROUPS[id].keywords,
]

/** Machine-wide policy rows: no folder renders them, on any machine. */
const POLICY = new Set([
  AGENT_ROW_TEXT.autoName.title,
  AGENT_ROW_TEXT.budget.title,
  AGENT_ROW_TEXT.instructions.title,
])
const atMachine = (entry: SettingEntry): SettingEntry => ({ ...entry, machineScope: true })

const DIRECTIVES: SettingRows = [
  row(AGENT_ROW_TEXT.instructions),
  ['Worktree guard', 'branch checkout'],
  ['Machine awareness', 'host local remote tailscale machine prompt'],
  ['Lane charter', 'pull request pr'],
  ['Sub-agent policy', 'subagent delegation'],
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
  // This Mac keeps directive switches per folder too; a Host only machine-wide.
  ...section('agent', group('directives'), DIRECTIVES, LOCAL_ONLY),
  ...section('agent', group('directives'), DIRECTIVES, { host: true }).map(atMachine),
].map((entry) => (POLICY.has(entry.title) ? atMachine(entry) : entry))
