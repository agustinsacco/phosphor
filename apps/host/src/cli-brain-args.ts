import type { BRAIN_METHODS } from '@phosphor/shared/host-brain'
import { brainVersionMode, parseHostBrainRequest } from '@phosphor/shared/host-brain-request'

const COMMANDS = {
  status: 'brain:status',
  prefs: 'brain:prefs',
  'set-prefs': 'brain:setPrefs',
  download: 'brain:download',
  'remove-model': 'brain:removeModel',
  reset: 'brain:reset',
  queue: 'brain:queue',
  cancel: 'brain:cancel',
  retry: 'brain:retry',
  reread: 'brain:reread',
  'never-read': 'brain:neverRead',
  'lane-read': 'brain:laneRead',
  'lane-state': 'brain:laneState',
  extraction: 'brain:extraction',
  changes: 'brain:tidyChanges',
  undo: 'brain:tidyUndo',
  defrag: 'brain:defrag',
  'stop-defrag': 'brain:defragStop',
  'undo-run': 'brain:undoRun',
  ask: 'brain:ask',
  tell: 'brain:tell',
  'set-owner': 'brain:setOwner',
  merge: 'brain:merge',
  describe: 'brain:describe',
  'remove-name': 'brain:removeName',
  split: 'brain:split',
  find: 'brain:find',
  overview: 'brain:overview',
  neighbourhood: 'brain:neighbourhood',
  entity: 'brain:entity',
  'entity-memories': 'brain:entityMemories',
  memory: 'brain:memory',
  path: 'brain:path',
  forget: 'brain:forget',
  'lane.show': 'brain:laneShow',
  'lane.watch': 'brain:laneWatch',
  'lane.send': 'brain:laneSend',
  'lane.stop': 'brain:laneStop',
  'lane.answer': 'brain:laneAnswer',
  'lane.take': 'brain:laneTake',
} as const satisfies Record<string, keyof typeof BRAIN_METHODS>

export const BRAIN_CLI_USAGE = `phosphor brain <command> --host local [--expected GENERATION:REVISION] [--args JSON_ARRAY] [--json]\n\n${Object.keys(COMMANDS).join(', ')}\n`

export function parseBrainCli(argv: readonly string[]) {
  const lane = argv[0] === 'lane'
  const name = (lane ? `lane.${argv[1] ?? ''}` : argv[0]) as keyof typeof COMMANDS | undefined
  if (!name || !Object.hasOwn(COMMANDS, name)) return null
  const method = COMMANDS[name]
  const flags = argv.slice(lane ? 2 : 1)
  let json = false
  const read = new Map<string, string>()
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    if (flag === '--json') {
      if (json) return null
      json = true
      continue
    }
    const val = flags[++i]
    if (!flag || !val || read.has(flag) || !['--host', '--args', '--expected'].includes(flag))
      return null
    read.set(flag, val)
  }
  if (read.get('--host') !== 'local') return null
  try {
    const args: unknown = JSON.parse(read.get('--args') ?? '[]')
    const stamp = read.get('--expected')?.match(/^([0-9a-f-]+):([0-9]+)$/i)
    if (read.has('--expected') && !stamp) return null
    if (!brainVersionMode(method) && stamp) return null
    const action = parseHostBrainRequest({
      method,
      args,
      ...(stamp ? { expected: { generation: stamp[1], revision: Number(stamp[2]) } } : {}),
    })
    return action ? { action, json } : null
  } catch {
    return null
  }
}
