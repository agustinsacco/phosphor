import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcCommand, RpcCommandType } from '@phosphor/shared/rpc'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { commandRefusal, unlinkTranscript } from './runtime'

const allowed = [
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'clear_queue',
  'get_state',
  'get_messages',
  'set_model',
  'cycle_model',
  'get_available_models',
  'set_thinking_level',
  'cycle_thinking_level',
  'get_available_thinking_levels',
  'set_steering_mode',
  'set_follow_up_mode',
  'compact',
  'set_auto_compaction',
  'set_auto_retry',
  'abort_retry',
  'bash',
  'abort_bash',
  'get_session_stats',
  'get_fork_messages',
  'get_entries',
  'get_tree',
  'get_last_assistant_text',
  'set_session_name',
  'get_commands',
  'export_html',
] satisfies RpcCommandType[]
const moves = ['new_session', 'switch_session', 'fork', 'clone'] satisfies RpcCommandType[]
// Compile-time inventory: a protocol addition must also be characterized.
const inventory: Record<RpcCommandType, true> = Object.fromEntries(
  [...allowed, ...moves].map((type) => [type, true]),
) as Record<(typeof allowed)[number] | (typeof moves)[number], true>

it.each(allowed)('runtime allows %s', (type) => {
  expect(inventory[type]).toBe(true)
  expect(commandRefusal({ type } as RpcCommand)).toBeNull()
})
it.each(moves)('runtime refuses %s', (type) => {
  expect(commandRefusal({ type } as RpcCommand)).toBe(
    `${type} moves pi to another session file: start or resume one with a request instead`,
  )
})
it.each([{}, { type: 'constructor' }, { type: 'toString' }, { type: 'unknown' }, { type: 1 }])(
  'runtime refuses unknown or inherited command %j',
  (command) => {
    expect(commandRefusal(command as RpcCommand)).toBe('not a pi command')
  },
)
it('runtime refuses an explicit export path, including an empty path', () => {
  for (const outputPath of ['', '/tmp/export.html']) {
    expect(commandRefusal({ type: 'export_html', outputPath })).toBe(
      'export_html takes no output path on a Host',
    )
  }
})

let dir: string
let folder: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-policy-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  folder = sessionDirForCwd(dir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
function write(file: string) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '{}\n')
  return file
}
it('runtime deletes only a direct regular transcript and tolerates absent file/folder', async () => {
  const file = write(join(folder, 'a.jsonl'))
  await unlinkTranscript(file)
  expect(existsSync(file)).toBe(false)
  await expect(unlinkTranscript(file)).resolves.toBeUndefined()
  await expect(unlinkTranscript(join(dir, 'gone/a.jsonl'))).resolves.toBeUndefined()
})
it('runtime invokes custom deletion with the canonical parent path', async () => {
  const file = write(join(folder, 'a.jsonl'))
  const alias = join(dir, 'alias')
  symlinkSync(folder, alias)
  const remove = vi.fn(async () => {})
  await unlinkTranscript(join(alias, 'a.jsonl'), remove)
  expect(remove).toHaveBeenCalledExactlyOnceWith(file)
  expect(existsSync(file)).toBe(true)
})
it('runtime never invokes custom deletion for outside, nested, suffix, link or directory targets', async () => {
  const target = write(join(folder, 'target.jsonl'))
  const link = join(folder, 'link.jsonl')
  symlinkSync(target, link)
  const directory = join(folder, 'directory.jsonl')
  mkdirSync(directory)
  const remove = vi.fn(async () => {})
  for (const [file, reason] of [
    [write(join(dir, 'outside.jsonl')), 'not a pi session'],
    [write(join(folder, 'nested/a.jsonl')), 'not a pi session'],
    [write(join(folder, 'a.txt')), 'not a pi session file'],
    [write(join(folder, '.jsonl')), 'not a pi session file'],
    [link, 'not a pi session file'],
    [directory, 'not a pi session file'],
  ]) {
    await expect(unlinkTranscript(file!, remove)).rejects.toThrow(reason)
    expect(existsSync(file!)).toBe(true)
  }
  expect(remove).not.toHaveBeenCalled()
  expect(existsSync(target)).toBe(true)
})
