import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearSubagentPrCache } from '@phosphor/session-runtime/pi/lane-pr-runs'
import * as fold from '@phosphor/session-runtime/pi/session-fold'
import { createLanePrReader } from './lane-pr-fold'

let dir: string
const RUN = '0e728808-669c-4ab1-b399-a8b6e249e14d'
const line = (value: object) => JSON.stringify(value) + '\n'
const header = { type: 'session', id: 'lane', cwd: '/repo' }
const user = (text: string) => ({ type: 'message', message: { role: 'user', content: text } })
const opened = (id: string, command: string, url: string) => [
  {
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: 'bash', arguments: { command } }],
    },
  },
  {
    type: 'message',
    message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: url }] },
  },
]
const ref = (number: number, repo = 'app') => ({ host: 'github.com', owner: 'acme', repo, number })

beforeEach(() => {
  clearSubagentPrCache()
  dir = mkdtempSync(join(tmpdir(), 'host-lane-prs-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

it('folds the lane file as the scan does: opened, pushed, mentioned, pinned', async () => {
  const file = join(dir, 'lane.jsonl')
  writeFileSync(
    file,
    [
      header,
      user('see https://github.com/acme/app/pull/3'),
      ...opened(
        't1',
        'git push -u origin feat && gh pr create',
        'https://github.com/acme/app/pull/7',
      ),
      { type: 'custom', customType: 'phosphor-prs', data: { action: 'pin', ref: ref(9, 'lib') } },
    ]
      .map(line)
      .join(''),
  )
  expect(await createLanePrReader()(file)).toStrictEqual({
    opened: [ref(7)],
    branches: ['feat'],
    reviewing: [],
    mentioned: [ref(3)],
    pinned: [ref(9, 'lib')],
    hidden: [],
  })
})

it('adds what subagent runs opened beside the lane file', async () => {
  const file = join(dir, 'lane.jsonl')
  writeFileSync(
    file,
    line(header) +
      line({ type: 'custom_message', customType: 'subagent-notify', content: `run ${RUN}` }),
  )
  const runDir = join(dir, 'lane', RUN, 'run-0')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'session.jsonl'),
    [
      { ...header, id: 'child' },
      ...opened('c1', 'gh pr create', 'https://github.com/acme/app/pull/11'),
    ]
      .map(line)
      .join(''),
  )
  expect(await createLanePrReader()(file)).toMatchObject({ opened: [ref(11)] })
})

it('answers undefined for a lane that points at nothing, and throws for a missing file', async () => {
  const file = join(dir, 'lane.jsonl')
  writeFileSync(file, line(header) + line(user('hello')))
  const read = createLanePrReader()
  expect(await read(file)).toBeUndefined()
  await expect(read(join(dir, 'gone.jsonl'))).rejects.toThrow()
})

it('reuses an unchanged answer and continues a fold when the file only grew', async () => {
  const file = join(dir, 'lane.jsonl')
  writeFileSync(file, line(header) + line(user('https://github.com/acme/app/pull/1')))
  const read = createLanePrReader()
  const reads = vi.spyOn(fold, 'readLinesFrom')
  expect(await read(file)).toMatchObject({ mentioned: [ref(1)] })
  expect(await read(file)).toMatchObject({ mentioned: [ref(1)] })
  expect(reads).toHaveBeenCalledTimes(1)
  const size = (await import('node:fs')).statSync(file).size
  appendFileSync(file, line(user('https://github.com/acme/app/pull/2')))
  expect(await read(file)).toMatchObject({ mentioned: [ref(1), ref(2)] })
  expect(reads).toHaveBeenCalledTimes(2)
  expect(reads.mock.calls[1]![1]).toBe(size)
})

it('keeps the wire limits on a lane that mentions many PRs', async () => {
  const file = join(dir, 'lane.jsonl')
  const links = Array.from({ length: 15 }, (_, i) => `https://github.com/acme/app/pull/${i + 1}`)
  writeFileSync(file, line(header) + line(user(links.join(' '))))
  const signals = await createLanePrReader()(file)
  expect(signals?.mentioned).toHaveLength(10)
})
