import { expect, it } from 'vitest'
import { OPS_LIMITS } from '../host-protocol-ops'
import { OP_CATALOG } from './index'
import { parseOpArgv } from '../ops-cli'

it.each([
  ['lanes', 'lane.list'],
  ['archives', 'archive.list'],
  ['hosts', 'hosts.list'],
  ['artifacts', 'artifact.list'],
  ['changes', 'audit.list'],
  ['whoami', 'whoami'],
])('expands %s to %s', (word, op) => {
  expect(parseOpArgv([word])).toEqual({ ok: true, op, args: {}, json: false })
})

it.each([
  {
    argv: ['lane', 'rename', `one "quoted" lane's name`],
    args: { name: `one "quoted" lane's name` },
  },
  { argv: ['notify', '--', '--json'], args: { text: '--json' } },
  {
    argv: ['lane.create', '--folder=--here', '--prompt', 'first\nsecond', '--fresh', 'on'],
    args: { folder: '--here', prompt: 'first\nsecond', fresh: true },
  },
  { argv: ['lane', 'pin', 'off'], args: { on: false } },
  { argv: ['lane', 'pin', 'true'], args: { on: true } },
  { argv: ['archive', 'list', '--measure', 'false'], args: { measure: false } },
  { argv: ['archive', 'purge', '--all', 'on'], args: { all: true } },
  { argv: ['archive', 'purge', '--ids', 'a,b', '--ids=c'], args: { ids: ['a', 'b', 'c'] } },
  { argv: ['help', 'lane.read'], args: { topic: 'lane.read' } },
  { argv: ['settings.set', 'contextBudget', '9000'], args: { key: 'contextBudget', value: 9000 } },
  {
    argv: ['routine.edit', 'r', '--revision', '0', '--patch', '{"name":"two words"}'],
    args: { id: 'r', revision: 0, patch: { name: 'two words' } },
  },
])('parses $argv as tokenized, schema-checked data', ({ argv, args }) => {
  expect(parseOpArgv(argv)).toMatchObject({ ok: true, args, json: false })
})

it('keeps routing, paging, reason and formatting outside the wire args', () => {
  expect(
    parseOpArgv([
      'lane',
      'read',
      'x',
      '--host',
      'a,My Mac',
      '--page',
      'v1_x-2',
      '--reason',
      'context for review',
      '--json',
    ]),
  ).toEqual({
    ok: true,
    op: 'lane.read',
    args: { ref: 'x' },
    hosts: ['a', 'My Mac'],
    page: 'v1_x-2',
    reason: 'context for review',
    json: true,
  })
  expect(parseOpArgv(['artifacts', '--host', 'all'])).toMatchObject({ ok: true, hosts: 'all' })
  expect(
    parseOpArgv([
      'brain',
      'flag',
      '1',
      'wrong',
      'a factual correction',
      '--reason',
      'fix the memory',
    ]),
  ).toMatchObject({ args: { reason: 'a factual correction' }, reason: 'fix the memory' })
  expect(parseOpArgv(['hosts', 'list'])).toMatchObject({ ok: true, op: 'hosts.list' })
})

it('maps separate tool fields without parsing or truncating the content', () => {
  const argv = ['instructions', 'edit', '--revision', 'null']
  const fits = 'é'.repeat(OPS_LIMITS.contentBytes / 2)
  expect(parseOpArgv(argv, undefined, { content: fits, reason: 'replace' })).toEqual({
    ok: true,
    op: 'instructions.edit',
    args: { revision: null, content: fits },
    reason: 'replace',
    json: false,
  })
  expect(parseOpArgv([...argv, '--content', ''], undefined)).toMatchObject({
    ok: true,
    args: { content: '' },
  })
  for (const content of [fits + 'a', '\n'.repeat(OPS_LIMITS.contentBytes)])
    expect(parseOpArgv(argv, undefined, { content })).toMatchObject({ ok: false })
  expect(parseOpArgv(['lane.list'], undefined, { content: 'x' })).toMatchObject({ ok: false })
  expect(parseOpArgv([...argv, '--content', 'x'], undefined, { content: 'y' })).toMatchObject({
    ok: false,
  })
  expect(parseOpArgv([...argv, '--reason', 'x'], undefined, { reason: 'y' })).toMatchObject({
    ok: false,
  })
})

it.each(
  [
    [],
    ['unknown'],
    ['lanes', '--constructor', 'x'],
    ['__proto__'],
    ['whoami', 'surplus'],
    ['files.rename', '--target', 'self', 'old'],
    ['lane.rename', 'new', '--name', 'other'],
    ['archive.purge', '--all', 'false'],
    ['archive.purge', '--ids', 'r', '--all', 'true'],
    ['routine.edit', 'r', '--revision', '0', '--patch', '{"allowOps":true}'],
    ['lane.read', 'x', '--messages', '51'],
    ['lane.pin', 'yes'],
    ['lane.create', '--folder', '--json'],
    ['hosts', '--host', 'somewhere'],
    ['artifacts', '--host', 'a,all'],
    ['lanes', '--host', 'a,,b'],
    ['lanes', '--host', 'a,A'],
    ['lanes', '--host', Array.from({ length: 21 }, (_, i) => `m${i}`).join(',')],
    ['changes', '--reason', 'x'.repeat(301)],
    ['changes', '--page', '!'],
    ['changes', '--page', 'x'.repeat(257)],
  ].map((argv) => ({ argv })),
)('rejects $argv with usage', ({ argv }) => {
  expect(parseOpArgv(argv)).toMatchObject({
    ok: false,
    error: expect.any(String),
    usage: expect.stringMatching(/^Usage: phosphor /),
  })
})

it('names the nearest flag and uses only the supplied catalog', () => {
  expect(parseOpArgv(['lane.create', '--folde', 'here'])).toMatchObject({
    ok: false,
    error: 'Unknown flag --folde. Did you mean --folder?',
  })
  expect(
    parseOpArgv(
      ['artifacts'],
      OP_CATALOG.filter((s) => s.name !== 'artifact.list'),
    ),
  ).toMatchObject({ ok: false })
})
