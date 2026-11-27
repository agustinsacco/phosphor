import type { HostBrainMethod } from '@phosphor/shared/host-brain'

/**
 * One plain operand of a Brain CLI command. `revision` and `fixed` are never typed: a revision
 * comes from `--expected`, a fixed value is the wire default (`--args` overrides both).
 */
export type BrainOperand =
  | { kind: 'text' | 'json'; name: string; optional?: true }
  | { kind: 'int'; name: string; fallback?: number; optional?: true }
  | { kind: 'on-off'; name: string }
  | { kind: 'revision' }
  | { kind: 'fixed'; value: unknown }

export interface BrainCommand {
  method: HostBrainMethod
  summary: string
  /** Absent: the arguments are structured and only `--args JSON_ARRAY` carries them. */
  operands?: readonly BrainOperand[]
}

const text = (name: string): BrainOperand => ({ kind: 'text', name })
const int = (name: string): BrainOperand => ({ kind: 'int', name })
const revision: BrainOperand = { kind: 'revision' }
const cursor: BrainOperand = { kind: 'text', name: 'cursor', optional: true }

/** The reviewed private Brain surface, by CLI spelling; `lane <verb>` drives Brain Agent's lane. */
export const BRAIN_COMMANDS = {
  status: {
    method: 'brain:status',
    summary: 'Show Brain status and its GENERATION:REVISION stamp.',
    operands: [],
  },
  prefs: { method: 'brain:prefs', summary: 'Show Brain settings.', operands: [] },
  'set-prefs': {
    method: 'brain:setPrefs',
    summary: 'Save Brain settings. Turning Brain on creates its store.',
    operands: [{ kind: 'json', name: 'settings-json' }],
  },
  download: { method: 'brain:download', summary: 'Retry the model download.', operands: [] },
  'remove-model': {
    method: 'brain:removeModel',
    summary: 'Remove the downloaded model.',
    operands: [],
  },
  reset: {
    method: 'brain:reset',
    summary: 'Delete all knowledge, jobs and records. Keeps settings and the model.',
    operands: [],
  },
  queue: {
    method: 'brain:queue',
    summary: 'Queue a lane on this Host for Brain to read.',
    operands: [text('lane-id')],
  },
  cancel: {
    method: 'brain:cancel',
    summary: 'Cancel a waiting, queued or running read.',
    operands: [text('job-id')],
  },
  retry: { method: 'brain:retry', summary: 'Requeue a failed read.', operands: [text('job-id')] },
  reread: {
    method: 'brain:reread',
    summary: 'Read a lane again from the start.',
    operands: [text('job-id')],
  },
  'never-read': {
    method: 'brain:neverRead',
    summary: 'on: Brain never reads the lane. off: it may read it again.',
    operands: [text('lane-id'), { kind: 'on-off', name: 'on|off' }],
  },
  'lane-read': {
    method: 'brain:laneRead',
    summary: 'Show the latest read of a lane.',
    operands: [text('lane-id')],
  },
  'lane-state': {
    method: 'brain:laneState',
    summary: 'Show whether a lane is excluded, its active read and its latest read.',
    operands: [text('lane-id')],
  },
  extraction: {
    method: 'brain:extraction',
    summary: 'Show what one read extracted.',
    operands: [text('job-id'), { kind: 'int', name: 'offset', optional: true }],
  },
  changes: {
    method: 'brain:tidyChanges',
    summary: 'List recent Brain changes (limit 1–100, default 20).',
    operands: [{ kind: 'int', name: 'limit', fallback: 20 }],
  },
  undo: {
    method: 'brain:tidyUndo',
    summary: 'Undo one change.',
    operands: [text('change-id'), revision],
  },
  defrag: { method: 'brain:defrag', summary: 'Start Defrag.', operands: [] },
  'stop-defrag': {
    method: 'brain:defragStop',
    summary: 'Stop Defrag. Changes it made stay.',
    operands: [],
  },
  'undo-run': {
    method: 'brain:undoRun',
    summary: 'Undo every change of one Defrag run that can still be undone.',
    operands: [text('run-id')],
  },
  ask: { method: 'brain:ask', summary: 'Ask Brain a question.', operands: [text('question')] },
  tell: {
    method: 'brain:tell',
    summary: 'Send Brain Agent a message.',
    operands: [text('message')],
  },
  'set-owner': {
    method: 'brain:setOwner',
    summary: "Say which entity is you. --args '[null]' forgets it.",
    operands: [text('entity-id')],
  },
  merge: {
    method: 'brain:merge',
    summary: 'Fold the first entity into the second.',
    operands: [text('source-id'), text('target-id'), revision],
  },
  describe: {
    method: 'brain:describe',
    summary: 'Replace an entity’s description.',
    operands: [text('entity-id'), text('description'), revision],
  },
  'remove-name': {
    method: 'brain:removeName',
    summary: 'Remove one of an entity’s other names.',
    operands: [text('entity-id'), text('name'), revision],
  },
  split: { method: 'brain:split', summary: 'Split memories off into a new entity.' },
  find: {
    method: 'brain:find',
    summary: 'Find entities and memories (limit 1–50, default 20).',
    operands: [text('query'), { kind: 'int', name: 'limit', fallback: 20 }],
  },
  overview: {
    method: 'brain:overview',
    summary: 'Show the best-connected entities.',
    operands: [],
  },
  neighbourhood: {
    method: 'brain:neighbourhood',
    summary: 'Show an entity’s neighbourhood (hops 1 or 2, default 1).',
    operands: [text('entity-id'), { kind: 'int', name: 'hops', fallback: 1 }],
  },
  entity: { method: 'brain:entity', summary: 'Show one entity.', operands: [text('entity-id')] },
  'entity-memories': {
    method: 'brain:entityMemories',
    summary: 'List an entity’s memories. Filters and later pages take --args.',
    operands: [text('entity-id'), { kind: 'fixed', value: {} }, { kind: 'fixed', value: null }],
  },
  memory: { method: 'brain:memory', summary: 'Show one memory.', operands: [text('memory-id')] },
  path: {
    method: 'brain:path',
    summary: 'Show how two entities connect.',
    operands: [text('from-id'), text('to-id')],
  },
  forget: { method: 'brain:forget', summary: 'Delete one memory.', operands: [text('memory-id')] },
  'lane show': {
    method: 'brain:laneShow',
    summary: 'Show Brain Agent’s latest conversation page.',
    operands: [cursor],
  },
  'lane watch': {
    method: 'brain:laneWatch',
    summary: 'Read Brain Agent’s current page once.',
    operands: [cursor],
  },
  'lane send': {
    method: 'brain:laneSend',
    summary: 'Send Brain Agent a message as its controller.',
    operands: [text('message'), int('fence')],
  },
  'lane stop': {
    method: 'brain:laneStop',
    summary: 'Stop the turn you started.',
    operands: [int('fence'), text('turn')],
  },
  'lane answer': { method: 'brain:laneAnswer', summary: 'Answer Brain Agent’s question.' },
  'lane take': {
    method: 'brain:laneTake',
    summary: 'Take control of Brain Agent’s lane.',
    operands: [int('fence')],
  },
} as const satisfies Record<string, BrainCommand>

export type BrainCommandName = keyof typeof BRAIN_COMMANDS

/** `status`, `lane send`, and the catalog spellings `lane.send` and `brain.status`. */
export function brainCommandName(words: readonly string[]): BrainCommandName | undefined {
  const [first = '', second = ''] = words
  const bare = first.startsWith('brain.') ? first.slice('brain.'.length) : first
  const name = bare === 'lane' ? `lane ${second}` : bare.replace(/^lane\./, 'lane ')
  return Object.hasOwn(BRAIN_COMMANDS, name) ? (name as BrainCommandName) : undefined
}

/** How many leading words name the command: two for `lane send`, one for `lane.send`. */
export const brainCommandWords = (words: readonly string[]) => (words[0] === 'lane' ? 2 : 1)
