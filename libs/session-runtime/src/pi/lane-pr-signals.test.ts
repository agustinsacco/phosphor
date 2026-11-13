import { describe, expect, it } from 'vitest'
import { emptyFold, foldLine, metaFromFold, cloneFold } from './session-fold'
import { LANE_PR_ENTRY, PR_SIGNAL_LIMITS } from './lane-pr-signals'

const URL_A = 'https://github.com/GoAugment/augment-services/pull/20244'
const URL_B = 'https://github.com/GoAugment/augment-dbt/pull/1923'
const ref = (repo: string, number: number) => ({
  host: 'github.com',
  owner: 'GoAugment',
  repo,
  number,
})

const header = JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/repo/wt' })
let n = 0
const entry = (value: object) => JSON.stringify({ id: `e${++n}`, parentId: null, ...value })
const call = (id: string, name: string, args: object) =>
  entry({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] },
  })
const result = (toolCallId: string, text: string, extra: object = {}) =>
  entry({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      ...extra,
    },
  })
const say = (role: 'user' | 'assistant', text: string) =>
  entry({ type: 'message', message: { role, content: [{ type: 'text', text }] } })
const override = (action: string, value = ref('augment-services', 1)) =>
  entry({ type: 'custom', customType: LANE_PR_ENTRY, data: { action, ref: value } })

function fold(lines: string[]) {
  const state = emptyFold()
  for (const line of [header, ...lines]) foldLine(state, line)
  return { state, meta: metaFromFold(state, '/s/a.jsonl', 1)! }
}

describe('lane PR signals', () => {
  it('records the PR a gh pr create printed, and the branch it named', () => {
    const { meta } = fold([
      call('c1', 'bash', {
        command:
          "cat > /tmp/b.md <<'EOF'\nbody\nEOF\ngh pr create --head agustin/a --body-file /tmp/b.md",
      }),
      result('c1', `${URL_A}\n`),
    ])
    expect(meta.pullRequests).toMatchObject({
      opened: [ref('augment-services', 20244)],
      branches: ['agustin/a'],
    })
  })

  it('records a GitHub MCP create, and an existing PR the create reported', () => {
    const { meta } = fold([
      call('m1', 'mcp__github__create_pull_request', { title: 'x' }),
      result('m1', JSON.stringify({ html_url: URL_B })),
      call('c2', 'bash', { command: 'gh pr create --fill' }),
      result('c2', `a pull request for branch "x" into branch "main" already exists:\n${URL_A}`, {
        isError: true,
      }),
    ])
    expect(meta.pullRequests?.opened).toEqual([
      ref('augment-dbt', 1923),
      ref('augment-services', 20244),
    ])
  })

  it('never treats a link in some other tool result as opened', () => {
    const { meta } = fold([
      call('v1', 'bash', { command: 'gh pr view 20244' }),
      result('v1', URL_A),
    ])
    expect(meta.pullRequests).toBeUndefined()
  })

  it('keeps prompt and reply links as mentions only', () => {
    const { meta } = fold([say('user', `Review ${URL_A}`), say('assistant', `Opened ${URL_B}.`)])
    expect(meta.pullRequests).toMatchObject({
      opened: [],
      mentioned: [ref('augment-services', 20244), ref('augment-dbt', 1923)],
    })
  })

  it('applies pins and hides in order, last one wins', () => {
    const { meta } = fold([
      override('pin'),
      override('hide', ref('augment-services', 2)),
      override('clear'),
      override('pin', ref('augment-services', 3)),
    ])
    expect(meta.pullRequests).toMatchObject({
      pinned: [ref('augment-services', 3)],
      hidden: [ref('augment-services', 2)],
    })
  })

  it('collects subagent run ids from results and notices', () => {
    const run = '606ef681-7929-4420-a660-3af9248c0289'
    const { state } = fold([
      entry({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 's',
          toolName: 'subagent',
          details: { runId: run },
        },
      }),
      entry({
        type: 'custom_message',
        customType: 'subagent-notify',
        content: `Child run: ${run}`,
      }),
    ])
    expect([...state.prs.runs]).toEqual([run])
  })

  it('folds incrementally to the same answer', () => {
    const lines = [
      call('c1', 'bash', { command: 'git worktree add -b agustin/a ../a' }),
      call('c2', 'bash', { command: 'cd ../a && gh pr create --fill' }),
      result('c2', URL_A),
      say('user', URL_B),
    ]
    const whole = fold(lines).meta.pullRequests
    const state = emptyFold()
    foldLine(state, header)
    foldLine(state, lines[0]!)
    foldLine(state, lines[1]!)
    const resumed = cloneFold(state)
    foldLine(resumed, lines[2]!)
    foldLine(resumed, lines[3]!)
    expect(metaFromFold(resumed, '/s/a.jsonl', 1)!.pullRequests).toEqual(whole)
    // The copy kept its own pending call: folding the original is unaffected.
    expect(state.prs.pending.has('c2')).toBe(true)
  })

  it('stays bounded', () => {
    const lines = Array.from({ length: PR_SIGNAL_LIMITS.opened + 10 }, (_, i) => [
      call(`c${i}`, 'bash', { command: `gh pr create --head agustin/b${i}` }),
      result(`c${i}`, `https://github.com/o/r/pull/${i + 1}`),
    ]).flat()
    const signals = fold(lines).meta.pullRequests!
    expect(signals.opened).toHaveLength(PR_SIGNAL_LIMITS.opened)
    expect(signals.branches).toHaveLength(PR_SIGNAL_LIMITS.branches)
  })
})
