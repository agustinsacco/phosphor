import { describe, expect, it } from 'vitest'
import {
  isTestCommand,
  parseLaneReceipt,
  receiptDuration,
  receiptDurationLabel,
  receiptFacts,
  receiptSummary,
  type LaneReceipt,
  type ReceiptTool,
} from './lane-receipt'

export const emptyReceipt: LaneReceipt = {
  title: 'Lane',
  repository: null,
  branch: null,
  settledAt: null,
  durationMs: null,
  files: 0,
  added: 0,
  removed: 0,
  tests: null,
  artifacts: 0,
  excerpt: null,
  outcome: 'done',
}
const tool = (extra: Partial<ReceiptTool>): ReceiptTool => ({ name: 'bash', done: true, ...extra })
describe('receipt facts', () => {
  it.each([
    'npm test',
    'pnpm test --run',
    'yarn test',
    'npm run test',
    'vitest run',
    'npx jest',
    'pytest -q',
    'cargo test',
    'go test ./...',
    'npx playwright test',
    'make test',
  ])('recognises %s', (command) => expect(isTestCommand(command)).toBe(true))
  it.each([
    'echo npm test',
    'npm tester',
    'npm test; echo ok',
    'npm test || true',
    'npm test && echo ok',
    'echo $(npm test)',
    'vitest\necho ok',
    'make build',
    'npm test > output',
  ])('rejects ambiguous %s', (command) => expect(isTestCommand(command)).toBe(false))
  it('requires completed tests and preserves a failure despite later passes', () => {
    expect(
      receiptFacts([tool({ args: { command: 'echo ok' }, details: { exitCode: 0 } })]).tests,
    ).toBeNull()
    expect(receiptFacts([])).toEqual({ files: 0, added: 0, removed: 0, tests: null, artifacts: 0 })
    expect(receiptFacts([tool({ args: { command: 'npm test' }, done: false })]).tests).toBeNull()
    expect(
      receiptFacts([tool({ args: { command: 'npm test' }, details: { exitCode: 0 } })]).tests,
    ).toBe('passed')
    expect(
      receiptFacts([
        tool({ args: { command: 'npm test' }, details: { exitCode: 1 }, error: true }),
        tool({ args: { command: 'vitest' }, details: { exitCode: 0 } }),
      ]).tests,
    ).toBe('failed')
    expect(
      receiptFacts([
        tool({ args: { command: 'pytest' }, text: 'Command exited with code 2', error: true }),
      ]).tests,
    ).toBe('failed')
    expect(receiptFacts([tool({ args: { command: 'pytest' }, text: 'all good' })]).tests).toBe(
      'passed',
    )
    expect(receiptFacts([tool({ args: { command: 'pytest' } })]).tests).toBeNull()
  })
  it('matches Changes accounting, deduplicates paths and artifacts, ignores failed or pending writes', () => {
    expect(
      receiptFacts(
        [
          tool({ name: 'write', args: { path: '/repo/a', content: 'a\nb' } }),
          tool({
            name: 'edit',
            args: { path: 'a' },
            details: { diff: '+ 18 new\n- 18 old\n  19 context' },
          }),
          tool({
            name: 'edit',
            args: { path: 'b' },
            details: { patch: '--- a\n+++ b\n-old\n+new\n+next' },
          }),
          tool({ name: 'write', args: { path: 'ignored', content: 'x' }, error: true }),
          tool({ name: 'write', args: { path: 'pending', content: 'x' }, done: false }),
          tool({ name: 'artifact_create', details: { id: 'one' } }),
          tool({ name: 'artifact_update', details: { id: 'one' } }),
          tool({ name: 'artifact_edit', details: { id: 'two' } }),
          tool({ name: 'artifact_read', details: { id: 'three' } }),
        ],
        '/repo',
      ),
    ).toEqual({ files: 2, added: 5, removed: 2, tests: null, artifacts: 2 })
  })
  it('formats measured duration without inventing a full second', () => {
    expect(receiptDurationLabel(20)).toBe('<1s')
    expect(receiptDurationLabel(4000)).toBe('4s')
    expect(receiptDurationLabel(240000)).toBe('4m')
    expect(receiptDurationLabel(245000)).toBe('4m 5s')
  })
  it('hides missing, invalid or reversed timing', () => {
    expect(receiptDuration(100, 120)).toBe(20)
    expect(receiptDuration(100, 100)).toBe(0)
    for (const [start, end] of [
      [null, 20],
      [10, undefined],
      [20, 10],
      [NaN, 1],
      [1, Infinity],
      [-1, 1],
    ])
      expect(receiptDuration(start, end)).toBeNull()
  })
  it('validates every boundary and builds facts-only system text', () => {
    expect(parseLaneReceipt(emptyReceipt)).toEqual(emptyReceipt)
    expect(parseLaneReceipt({ ...emptyReceipt, excerpt: 'x'.repeat(140) })).not.toBeNull()
    for (const patch of [
      { settledAt: -1 },
      { settledAt: Infinity },
      { settledAt: 'bad' },
      { files: -1 },
      { added: 0.5 },
      { removed: Infinity },
      { artifacts: '1' },
      { durationMs: -1 },
      { tests: 'yes' },
      { outcome: 'ok' },
      { excerpt: 'x'.repeat(141) },
      { title: 'x'.repeat(2001) },
      { branch: {} },
      { repository: [] },
    ])
      expect(parseLaneReceipt({ ...emptyReceipt, ...patch })).toBeNull()
    expect(
      receiptSummary({
        ...emptyReceipt,
        title: 'private',
        excerpt: 'secret',
        repository: 'secret',
        branch: 'secret',
        durationMs: 4000,
        files: 1,
        tests: 'passed',
      }),
    ).toBe('Done in 4s · 1 file changed · tests pass')
    expect(receiptSummary({ ...emptyReceipt, outcome: 'error' })).toBe('Stopped')
  })
})
