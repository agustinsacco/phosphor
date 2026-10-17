import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  normalizeCollection,
  normalizeExecution,
  compareInventories,
  validateRelocationMap,
  captureInventory,
} from '../test-inventory.mjs'

const root = resolve(import.meta.dirname, '../../..')
const file = 'apps/host/src/sample.test.ts'
const moved = 'apps/host/test/sample.test.ts'
const map = { version: 1, moves: [{ from: file, to: moved, kind: 'test', hash: 'ignored' }] }
const collected = (names = ['suite > test'], path = file) =>
  names.map((name) => ({ name, file: join(root, path) }))
const execution = (statuses = ['passed'], path = file) => ({
  testResults: [
    {
      name: join(root, path),
      status: statuses.includes('failed') ? 'failed' : 'passed',
      message: '',
      assertionResults: statuses.map((status) => ({
        fullName: 'suite test',
        ancestorTitles: ['suite'],
        title: 'test',
        status,
      })),
    },
  ],
})
const options = { root }

describe('test-inventory normalization and move parity', () => {
  it('maps relocated paths back to old source-equivalent identities', () => {
    const before = normalizeCollection(collected(), options)
    const after = normalizeCollection(collected(undefined, moved), { root, map })
    expect(after.cases[0]).toMatchObject({
      project: 'host',
      path: 'src/sample.test.ts',
      fullName: 'suite > test',
      ordinal: 1,
    })
    expect(compareInventories(before, after, { map }).equal).toBe(true)
    // A map can also be supplied only at comparison time.
    expect(
      compareInventories(before, normalizeCollection(collected(undefined, moved), options), { map })
        .equal,
    ).toBe(true)
  })

  it('retains the duplicate-name multiset and distinct parameterized cases', () => {
    const before = normalizeCollection(collected(['same', 'same', 'case 1', 'case 2']), options)
    expect(
      before.cases.filter((entry) => entry.fullName === 'same').map((entry) => entry.ordinal),
    ).toEqual([1, 2])
    const after = normalizeCollection(collected(['same', 'case 1', 'case 2']), options)
    const diff = compareInventories(before, after)
    expect(diff.equal).toBe(false)
    expect(diff.missing).toHaveLength(1)
    expect(diff.missing[0]).toMatchObject({ fullName: 'same', ordinal: 2 })
  })

  it('separates listed collection counts from all executed states and identities', () => {
    const run = normalizeExecution(
      execution(['passed', 'skipped', 'pending', 'todo', 'failed']),
      options,
    )
    expect(run.counts).toEqual({
      collected: 0,
      executed: { total: 5, passed: 1, skipped: 2, todo: 1, failed: 1 },
    })
    expect(run.cases.map((entry) => entry.status)).toEqual([
      'passed',
      'skipped',
      'skipped',
      'todo',
      'failed',
    ])
    expect(normalizeCollection(collected(), options).counts).toEqual({
      collected: 1,
      executed: null,
    })
    expect(() => compareInventories(normalizeCollection(collected(), options), run)).toThrow(/kind/)
    const missingSkip = normalizeExecution(execution(['passed']), options)
    expect(compareInventories(run, missingSkip).missing).toHaveLength(4)
  })

  it('compares execution moves, including skips, and surfaces status changes', () => {
    const before = normalizeExecution(execution(['skipped', 'todo']), options)
    const after = normalizeExecution(execution(['skipped', 'todo'], moved), options)
    expect(compareInventories(before, after, { map }).equal).toBe(true)
    const changed = normalizeExecution(execution(['passed', 'todo'], moved), options)
    expect(compareInventories(before, changed, { map }).statusChanges).toHaveLength(1)
  })

  it('records runtime platform and refuses cross-platform comparisons by default', () => {
    const before = normalizeCollection(collected(), options)
    expect(before.platform).toEqual({
      os: process.platform,
      nodeMajor: Number(process.versions.node.split('.')[0]),
    })
    const after = { ...before, platform: { os: 'other', nodeMajor: 1 } }
    expect(() => compareInventories(before, after)).toThrow(/platform/)
    expect(compareInventories(before, after, { allowPlatformMismatch: true }).equal).toBe(true)
  })

  it('excludes fixture cases but fails closed on fixture-only collections', () => {
    const fixture = collected(['fixture'], 'apps/host/src/__fixtures__/example.test.ts')
    expect(normalizeCollection([...collected(), ...fixture], options).cases).toHaveLength(1)
    expect(() => normalizeCollection(fixture, options)).toThrow(/Empty/)
  })

  it.each([null, {}, [], [{ name: 'test' }], [{ file: join(root, file), name: 42 }]])(
    'rejects malformed list JSON: %j',
    (input) => {
      expect(() => normalizeCollection(input, options)).toThrow()
    },
  )
  it.each([
    null,
    {},
    { testResults: [] },
    { testResults: [{ name: join(root, file) }] },
    execution(['unknown']),
  ])('rejects malformed execution JSON: %j', (input) => {
    expect(() => normalizeExecution(input, options)).toThrow()
  })
  it('rejects suite-level failures even when there are no failed assertions', () => {
    const report = execution()
    report.testResults[0].status = 'failed'
    report.testResults[0].message = 'Failed to load Monaco'
    expect(() => normalizeExecution(report, options)).toThrow(/suite/i)
  })

  it('validates versioned relocation paths and collision rules, ignoring unrelated fields', () => {
    expect(validateRelocationMap()).toEqual([])
    expect(validateRelocationMap(map)).toEqual([{ from: file, to: moved }])
    for (const value of [
      {},
      { version: 2, moves: [] },
      { version: 1, moves: [{ from: '../escape', to: moved }] },
      { version: 1, moves: [{ from: file, to: '/absolute' }] },
      { version: 1, moves: [{ from: file, to: 'C:/absolute' }] },
      {
        version: 1,
        moves: [
          { from: file, to: moved },
          { from: file, to: 'other' },
        ],
      },
      {
        version: 1,
        moves: [
          { from: file, to: moved },
          { from: 'other', to: moved },
        ],
      },
    ])
      expect(() => validateRelocationMap(value)).toThrow()
  })

  it('rejects malformed normalized inventories rather than reporting false parity', () => {
    expect(() => compareInventories({}, {})).toThrow()
    const valid = normalizeCollection(collected(), options)
    expect(() => compareInventories(valid, { ...valid, cases: [] })).toThrow()
    expect(() => compareInventories(valid, { ...valid, counts: {} })).toThrow()
  })
})

const temporary = mkdtempSync(join(tmpdir(), 'phosphor-inventory-test-'))
afterAll(() => rmSync(temporary, { recursive: true, force: true }))
it('wraps real Vitest list/run reports, retaining parameterized and skipped identities', () => {
  const config = join(temporary, 'vitest.config.mjs')
  const test = join(temporary, 'cases.test.mjs')
  // Import Vitest from the installation; the fixture itself lives outside the repo.
  writeFileSync(config, `export default { test: { include: ['cases.test.mjs'] } }`)
  writeFileSync(
    test,
    `import { it } from ${JSON.stringify(join(root, 'node_modules/vitest/dist/index.js'))};
    it.each([1,2])('case %s', () => {}); it.skip('platform skip', () => {}); it.todo('later');`,
  )
  const projects = [{ name: 'fixture', roots: ['suite'] }]
  const invoke = (_command: string, args: string[]) => {
    const command = args[1]
    const output = args.find((arg) => arg.startsWith('--json=') || arg.startsWith('--outputFile='))!
    execFileSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        command,
        `--config=${config}`,
        ...args.slice(2).filter((arg) => !arg.startsWith('--root=')),
      ],
      { cwd: temporary },
    )
    const reportPath = output.slice(output.indexOf('=') + 1)
    const data = JSON.parse(readFileSync(reportPath, 'utf8'))
    // Rebase the fixture path onto a known project for the normalizer.
    if (Array.isArray(data))
      for (const entry of data) entry.file = join(root, 'suite/cases.test.mjs')
    else for (const entry of data.testResults) entry.name = join(root, 'suite/cases.test.mjs')
    writeFileSync(reportPath, JSON.stringify(data))
  }
  const collection = captureInventory('collect', { root, projects, invoke })
  const run = captureInventory('run', { root, projects, invoke })
  expect(collection.counts.collected).toBe(2)
  expect(run.counts.executed).toEqual({ total: 4, passed: 2, skipped: 1, todo: 1, failed: 0 })
  expect(run.cases.map((entry) => entry.fullName)).toContain('platform skip')
}, 30_000)

it('CLI compare exits nonzero on dropped cases and malformed reports', () => {
  const before = join(temporary, 'before.json')
  const after = join(temporary, 'after.json')
  writeFileSync(before, JSON.stringify(normalizeCollection(collected(['one', 'two']), options)))
  writeFileSync(after, JSON.stringify(normalizeCollection(collected(['one']), options)))
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'tools/scripts/test-inventory.mjs'),
      'compare',
      '--before',
      before,
      '--after',
      after,
    ],
    { encoding: 'utf8' },
  )
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stdout).missing).toHaveLength(1)
})

it('does not collapse duplicate cases while both old and new layouts coexist', () => {
  const before = normalizeCollection(collected(), options)
  const after = normalizeCollection([...collected(), ...collected(undefined, moved)], options)
  const diff = compareInventories(before, after, { map })
  expect(diff.equal).toBe(false)
  expect(diff.added).toHaveLength(1)
  expect(diff.added[0]).toMatchObject({ fullName: 'suite > test', ordinal: 2 })
})
it('retains failed execution reports but rejects partial collection or process failures', () => {
  const invoke = (_command: string, args: string[]) => {
    const output = args.find((arg) => arg.startsWith('--outputFile='))!
    writeFileSync(output.slice('--outputFile='.length), JSON.stringify(execution(['failed'])))
    throw new Error('nonzero test process')
  }
  expect(captureInventory('run', { root, invoke }).counts.executed.failed).toBe(1)
  expect(() =>
    captureInventory('collect', {
      root,
      invoke: () => {
        throw new Error('collection failed')
      },
    }),
  ).toThrow(/collection failed/)
  expect(() => captureInventory('run', { root, invoke: () => {} })).toThrow()
})
