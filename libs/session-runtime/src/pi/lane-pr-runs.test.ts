import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { emptyFold, foldFrom } from './session-fold'
import { clearSubagentPrCache, withSubagentPrs } from './lane-pr-runs'

let dir: string
let outside: string
const RUN_A = '0e728808-669c-4ab1-b399-a8b6e249e14d'
const RUN_B = 'c67d87e1-045f-4e73-9b17-99b8f2ab8311'
const RUN_C = '52aecb3b-c690-448e-8185-f4caad56c248'

const lines = (...values: object[]) => values.map((v) => JSON.stringify(v)).join('\n') + '\n'
const header = (id: string, parentSession?: string) => ({
  type: 'session',
  id,
  cwd: '/repo/wt',
  ...(parentSession ? { parentSession } : {}),
})
const notice = (run: string) => ({
  type: 'custom_message',
  customType: 'subagent-notify',
  content: `Child run: ${run}`,
})
/** A worker run that opened a PR from its own branch. */
function run(folder: string, id: string, number: number, branch: string): string {
  const path = join(dir, folder, id, 'run-0')
  mkdirSync(path, { recursive: true })
  writeFileSync(
    join(path, 'session.jsonl'),
    lines(
      header(`child-${id}`),
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 't1',
              name: 'bash',
              arguments: { command: `git push -u origin ${branch} && gh pr create --fill` },
            },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 't1',
          content: [{ type: 'text', text: `https://github.com/o/r/pull/${number}` }],
        },
      },
      // A subagent's own reply never makes a mention.
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'https://github.com/o/r/pull/9' }],
        },
      },
    ),
  )
  return path
}

async function signals(file: string, parentSession?: string) {
  const state = emptyFold()
  await foldFrom(join(dir, file), 0, state)
  return withSubagentPrs(join(dir, file), parentSession && join(dir, parentSession), state.prs)
}

beforeEach(() => {
  clearSubagentPrCache()
  dir = mkdtempSync(join(tmpdir(), 'lane-pr-runs-'))
  outside = mkdtempSync(join(tmpdir(), 'lane-pr-outside-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

it('adds PRs and branches from the lane’s own subagent runs, never their mentions', async () => {
  writeFileSync(join(dir, 'lane.jsonl'), lines(header('lane')))
  run('lane', RUN_A, 20244, 'agustin/a')
  const result = await signals('lane.jsonl')
  expect(result?.opened.map((r) => r.number)).toEqual([20244])
  expect(result?.branches).toEqual(['agustin/a'])
  expect(result?.mentioned).toEqual([])
})

it('follows a fork back to the runs its copied entries name, and only those', async () => {
  writeFileSync(join(dir, 'parent.jsonl'), lines(header('parent'), notice(RUN_B)))
  run('parent', RUN_B, 20246, 'agustin/b')
  run('parent', RUN_C, 1, 'agustin/after-the-fork-point')
  writeFileSync(
    join(dir, 'fork.jsonl'),
    lines(header('fork', join(dir, 'parent.jsonl')), notice(RUN_B)),
  )
  const result = await signals('fork.jsonl', 'parent.jsonl')
  expect(result?.opened.map((r) => r.number)).toEqual([20246])
})

it('never leaves the session directory or follows a symlinked transcript', async () => {
  const foreign = join(outside, 'parent')
  mkdirSync(join(foreign, RUN_B, 'run-0'), { recursive: true })
  writeFileSync(join(outside, 'parent.jsonl'), lines(header('parent')))
  writeFileSync(
    join(dir, 'fork.jsonl'),
    lines(header('fork', join(outside, 'parent.jsonl')), notice(RUN_B)),
  )
  const real = run('elsewhere', RUN_A, 7, 'agustin/x')
  mkdirSync(join(dir, 'fork', RUN_A, 'run-0'), { recursive: true })
  symlinkSync(join(real, 'session.jsonl'), join(dir, 'fork', RUN_A, 'run-0', 'session.jsonl'))
  const state = emptyFold()
  await foldFrom(join(dir, 'fork.jsonl'), 0, state)
  expect(
    await withSubagentPrs(join(dir, 'fork.jsonl'), join(outside, 'parent.jsonl'), state.prs),
  ).toBeUndefined()
})
