import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseOrigin, type ReleaseOrigin } from '../test/__fixtures__/release-origin'
import { claimLease, readState, MEMORY_MAX, type Claimant, type Run } from './release-lease'
import { POLICY_PATH } from './release-github'
import { ANSWER_MESSAGE } from './release-prompt'
import { registerReleaseTools, RELEASE_TOOLS, type ReleaseRuntime } from './release-tools'

type Execute = (
  id: string,
  params: Record<string, unknown>,
  signal?: unknown,
  update?: unknown,
  ctx?: unknown,
) => Promise<{ content: Array<{ text: string }> }>

const HEAD = 'a'.repeat(40)
const T = Date.parse('2026-11-02T12:00:00Z')
const bee: Claimant = { holder: 'bee2/one', host: 'bee2', pid: process.pid }
const stark: Claimant = { holder: 'stark/two', host: 'stark', pid: process.pid }
const origins: ReleaseOrigin[] = []
afterEach(() => origins.splice(0).forEach((origin) => origin.cleanup()))

interface Options {
  epoch?: number
  /** Runs once while the tool looks at the pull request, before anything merges. */
  meanwhile?: (git: Run) => Promise<unknown>
}

async function fixture(options: Options = {}) {
  const origin = await releaseOrigin()
  origins.push(origin)
  await claimLease(origin.git, 'refs/test/a', bee, T)
  const tools = new Map<string, { execute: Execute; defaultActive?: boolean }>()
  const pi = {
    registerTool: (tool: Record<string, unknown>) =>
      void tools.set(tool.name as string, tool as never),
    sendMessage: vi.fn(),
  }
  let meanwhile = options.meanwhile
  const inspect = async () => {
    const work = meanwhile
    meanwhile = undefined
    await work?.(origin.git)
  }
  const gh = vi.fn(async (args: string[]) => {
    if (args[1] !== 'merge') await inspect()
    return 'merged\n'
  })
  const git: Run = async (args, input) => {
    if (args[0] === 'diff') await inspect()
    return origin.git(args, input)
  }
  const runtime: ReleaseRuntime = {
    git,
    gh,
    local: () => 'refs/test/a',
    claimant: () => bee,
    epoch: () => ('epoch' in options ? options.epoch : 1),
    policy: () => ({ base: 'main', merge: 'squash' }),
    exclusive: (work) => work(),
    flag: vi.fn(),
    lost: vi.fn(),
    now: () => T + 1000,
  }
  registerReleaseTools(pi, runtime)
  const run = (name: string, params: Record<string, unknown>, ctx?: unknown) =>
    tools.get(name)!.execute('call', params, undefined, undefined, ctx)
  return { tools, pi, gh, runtime, run, git: origin.git, pull: origin.pull }
}

const merged = (gh: ReturnType<typeof vi.fn>) =>
  gh.mock.calls.some(([args]) => (args as string[])[1] === 'merge')

describe('release tools', () => {
  it('registers every tool inactive', async () => {
    const f = await fixture()
    expect([...f.tools.keys()]).toEqual(RELEASE_TOOLS)
    expect([...f.tools.values()].every((tool) => tool.defaultActive === false)).toBe(true)
  })

  it('merges the reviewed head under the lease and logs it', async () => {
    const f = await fixture()
    const head = await f.pull(12)
    const result = await f.run('release_merge', { pr: 12, head })
    expect(result.content[0]?.text).toContain(`merged #12 at ${head.slice(0, 7)}`)
    expect(f.gh).toHaveBeenLastCalledWith([
      'pr',
      'merge',
      '12',
      '--squash',
      '--match-head-commit',
      head,
    ])
    const state = await readState(f.git, 'refs/test/b')
    expect(state.ledger.at(-1)).toContain(`merged #12 at ${head.slice(0, 7)}`)
  })

  it('refuses without the lease, on a stale epoch or a short head', async () => {
    await expect(
      (await fixture({ epoch: undefined })).run('release_merge', { pr: 1, head: HEAD }),
    ).rejects.toThrow(/does not hold the release lease/)
    const stale = await fixture({ epoch: 7 })
    const head = await stale.pull(1)
    await expect(stale.run('release_merge', { pr: 1, head })).rejects.toThrow(
      /another lane holds the release lease/,
    )
    expect(stale.runtime.lost).toHaveBeenCalled()
    expect(merged(stale.gh)).toBe(false)
    await expect(stale.run('release_merge', { pr: 1, head: 'abc123' })).rejects.toThrow(
      /full commit/,
    )
  })

  it('judges the policy on the reviewed commit, renames and deletions included', async () => {
    const f = await fixture()
    const renamed = await f.pull(3, (work) =>
      renameSync(join(work, POLICY_PATH), join(work, '.github/old-policy.md')),
    )
    await expect(f.run('release_merge', { pr: 3, head: renamed })).rejects.toThrow(
      /changes \.github\/release-manager\.md/,
    )
    await f.pull(4)
    await expect(f.run('release_merge', { pr: 4, head: HEAD })).rejects.toThrow(
      /not the aaaaaaa you reviewed/,
    )
    expect(merged(f.gh)).toBe(false)
  })

  it('merges nothing when the lease changes hands while the pull request is checked', async () => {
    const f = await fixture({
      meanwhile: (git) => claimLease(git, 'refs/test/s', stark, T + 1000, true),
    })
    const head = await f.pull(5)
    await expect(f.run('release_merge', { pr: 5, head })).rejects.toThrow(
      /another lane holds the release lease/,
    )
    expect(f.runtime.lost).toHaveBeenCalled()
    expect(merged(f.gh)).toBe(false)
  })

  it('saves memory and events on origin, within the limit', async () => {
    const f = await fixture()
    await f.run('release_memory', { memory: '# Standing orders\n- none', event: 'pass 1' })
    const state = await readState(f.git, 'refs/test/b')
    expect(state.memory).toBe('# Standing orders\n- none')
    expect(state.ledger.at(-1)).toContain('pass 1')
    await expect(f.run('release_memory', {})).rejects.toThrow(/memory or event/)
    await expect(f.run('release_memory', { memory: 'x'.repeat(MEMORY_MAX + 1) })).rejects.toThrow(
      /Summarize/,
    )
  })

  it('saves nothing, and drops to standby, once another lane holds the lease', async () => {
    const f = await fixture()
    await claimLease(f.git, 'refs/test/s', stark, T + 500, true)
    await expect(f.run('release_memory', { memory: 'mine' })).rejects.toThrow(/no longer holds/)
    expect(f.runtime.lost).toHaveBeenCalled()
    expect((await readState(f.git, 'refs/test/b')).memory).toBe('')
  })

  it('asks without blocking, then delivers the answer or the default as a message', async () => {
    const f = await fixture()
    let answer!: (value: string | undefined) => void
    const select = vi.fn(() => new Promise<string | undefined>((resolve) => (answer = resolve)))
    const params = { question: 'Merge #4?', options: ['yes', 'no'], default: 'no', wait_minutes: 5 }
    await expect(
      f.run('release_ask', { ...params, default: 'maybe' }, { ui: { select } }),
    ).rejects.toThrow(/one of the options/)
    const result = await f.run('release_ask', params, { ui: { select } })
    expect(result.content[0]?.text).toContain('the default (no) applies')
    expect(select).toHaveBeenCalledWith('Merge #4?', ['yes', 'no'], { timeout: 300_000 })
    expect(f.pi.sendMessage).not.toHaveBeenCalled()
    answer(undefined)
    await vi.waitFor(() => expect(f.pi.sendMessage).toHaveBeenCalled())
    expect(f.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: ANSWER_MESSAGE,
        content: 'No answer to "Merge #4?" within 5 minutes. Going with the default: no.',
      }),
      { triggerTurn: true, deliverAs: 'followUp' },
    )
  })

  it('flags the pass for an alert', async () => {
    const f = await fixture()
    await f.run('release_flag', {})
    expect(f.runtime.flag).toHaveBeenCalled()
  })
})
