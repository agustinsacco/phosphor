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
    parseOpArgv(
      [
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
      ],
      OP_CATALOG.map((s) => (s.name === 'lane.read' ? { ...s, paged: true as const } : s)),
    ),
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

it.each([
  [['lane', 'queue-mode', 'follow-up', 'one-at-a-time'], 'lane.queueMode'],
  [['routine.history', '--run-id=run-1'], 'routine.history'],
  [['lane.mark-read', 'lane-a'], 'lane.markRead'],
  [['mcp', 'status', 'example'], 'mcp.check'],
  [['routine', 'pause', 'r'], 'routine.disable'],
  [['routine', 'resume', 'r'], 'routine.enable'],
])('resolves %j to the canonical wire name', (argv, op) => {
  expect(parseOpArgv(argv)).toMatchObject({ ok: true, op })
})

it.each([
  [['lane.read', 'x', '--part', 'private-input'], 'part', 'summary|messages|artifacts|prs|debug'],
  [['lane.read', 'x', '--messages', '101'], 'messages', '1–50'],
  [['routine.create', '--definition', '{"name":"example"}'], 'definition', 'instructions'],
  [['archive.purge', '--ids', 'entry', '--all', 'true'], 'arguments', 'exactly one of ids, all'],
  [['archive.purge', '--all', 'private-input'], 'all', 'true.'],
])('names the field and the constraint for %j', (argv, field, expected) => {
  const result = parseOpArgv(argv)
  expect(result).toMatchObject({ ok: false })
  if (result.ok) throw new Error('Expected a refusal')
  expect(result.error).toContain(field)
  expect(result.error).toContain(expected)
  expect(result.error).not.toContain('private-input')
})

it.each([
  [['lan', 'read'], 'Did you mean lane?'],
  [['lane', 'rea'], 'Did you mean read?'],
  [['lane.read', 'x', '--completely-unrelated', 'x'], null],
  [['lane', 'lid'], null],
])('suggests only a close, unambiguous match for %j', (argv, hint) => {
  const result = parseOpArgv(argv)
  expect(result).toMatchObject({ ok: false })
  if (result.ok) throw new Error('Expected a refusal')
  if (hint) expect(result.error).toContain(hint)
  else expect(result.error).not.toContain('Did you mean')
})

it('accepts reserved paging options only for paged ops and preserves a declared limit field', () => {
  const catalog = OP_CATALOG.map((s) =>
    ['lane.list', 'audit.list'].includes(s.name) ? { ...s, paged: true as const } : s,
  )
  expect(parseOpArgv(['lanes', '--limit', '9'], catalog)).toMatchObject({
    ok: true,
    limit: 9,
    args: {},
  })
  expect(parseOpArgv(['changes', '--limit', '9'], catalog)).toEqual({
    ok: true,
    op: 'audit.list',
    args: { limit: 9 },
    json: false,
  })
  for (const value of ['0', '101', '1.5'])
    expect(parseOpArgv(['lanes', '--limit', value], catalog)).toMatchObject({
      ok: false,
      error: expect.stringContaining('1–100'),
    })
  for (const flag of ['--limit', '--page'])
    expect(parseOpArgv(['whoami', flag, '1'], catalog)).toMatchObject({
      ok: false,
      error: expect.stringContaining(`does not accept ${flag}`),
    })
})

it('merges long tool content into routine instructions before validating its definition', () => {
  const definition = {
    name: 'Morning digest',
    repositoryId: 'repo1',
    isolated: false,
    intent: 'report',
    provider: 'sample',
    model: 'sample',
    timezone: 'UTC',
    schedule: { kind: 'manual' },
    period: 'none',
    catchUpHours: 0,
    maxRuntimeMinutes: 10,
  }
  const instructions = 'Write a digest. '.repeat(400)
  const argv = ['routine', 'create', '--definition', JSON.stringify(definition)]
  expect(parseOpArgv(argv, undefined, { content: instructions })).toMatchObject({
    ok: true,
    args: { definition: { ...definition, instructions } },
  })
  expect(
    parseOpArgv(
      [...argv.slice(0, -1), JSON.stringify({ ...definition, instructions: 'short' })],
      undefined,
      { content: instructions },
    ),
  ).toMatchObject({ ok: false, error: expect.stringContaining('instructions') })
})

it.each([
  ['help', 'lane', 'read'],
  ['help', 'lane.read'],
  ['lane', 'read', '--help'],
])('parses %j as the same help topic', (...argv) => {
  expect(parseOpArgv(argv)).toMatchObject({ ok: true, op: 'help', args: { topic: 'lane.read' } })
})

it('does not discard help options or trailing operands when normalizing a two-word topic', () => {
  expect(parseOpArgv(['help', 'lane', 'read', '--json'])).toMatchObject({
    ok: true,
    op: 'help',
    args: { topic: 'lane.read' },
    json: true,
  })
  expect(parseOpArgv(['help', 'lane', 'read', '--', 'extra'])).toMatchObject({
    ok: false,
    op: 'help',
  })
})

it('keeps a declared limit on a non-paged op without opening common paging', () => {
  expect(parseOpArgv(['brain', 'search', 'example', '--limit', '5'])).toEqual({
    ok: true,
    op: 'brain.search',
    args: { query: 'example', limit: 5 },
    json: false,
  })
  expect(parseOpArgv(['brain', 'search', 'example', '--limit', '21'])).toMatchObject({
    ok: false,
    error: 'limit: expected an integer 1–20.',
  })
  expect(parseOpArgv(['brain', 'search', 'example', '--page', 'cursor'])).toMatchObject({
    ok: false,
    error: expect.stringContaining('only paged operations'),
  })
})
