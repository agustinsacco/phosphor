import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseOrigin, type ReleaseOrigin } from '../test/__fixtures__/release-origin'
import { claimLease, readState, MEMORY_MAX } from './release-lease'
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
const origins: ReleaseOrigin[] = []
afterEach(() => origins.splice(0).forEach((origin) => origin.cleanup()))

async function fixture(options: { epoch?: number; files?: string } = {}) {
  const origin = await releaseOrigin()
  origins.push(origin)
  await claimLease(origin.git, 'refs/test/a', { holder: 'bee2/one', host: 'bee2' }, T)
  const tools = new Map<string, { execute: Execute; defaultActive?: boolean }>()
  const pi = {
    registerTool: (tool: Record<string, unknown>) =>
      void tools.set(tool.name as string, tool as never),
    sendMessage: vi.fn(),
  }
  const gh = vi.fn(async (args: string[]) =>
    args[1] === 'diff' ? (options.files ?? 'src/a.ts\n') : 'merged\n',
  )
  const runtime: ReleaseRuntime = {
    git: origin.git,
    gh,
    local: () => 'refs/test/a',
    holder: () => 'bee2/one',
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
  return { tools, pi, gh, runtime, run, git: origin.git }
}

describe('release tools', () => {
  it('registers every tool inactive', async () => {
    const f = await fixture()
    expect([...f.tools.keys()]).toEqual(RELEASE_TOOLS)
    expect([...f.tools.values()].every((tool) => tool.defaultActive === false)).toBe(true)
  })

  it('merges the reviewed head under the lease and logs it', async () => {
    const f = await fixture()
    const result = await f.run('release_merge', { pr: 12, head: HEAD })
    expect(result.content[0]?.text).toContain('merged #12 at aaaaaaa')
    expect(f.gh).toHaveBeenLastCalledWith([
      'pr',
      'merge',
      '12',
      '--squash',
      '--match-head-commit',
      HEAD,
    ])
    const state = await readState(f.git, 'refs/test/b')
    expect(state.ledger.at(-1)).toContain('merged #12 at aaaaaaa')
  })

  it('refuses without the lease, on a stale epoch, a short head or a policy change', async () => {
    await expect(
      (await fixture({ epoch: undefined })).run('release_merge', { pr: 1, head: HEAD }),
    ).rejects.toThrow(/does not hold the release lease/)
    const stale = await fixture({ epoch: 7 })
    await expect(stale.run('release_merge', { pr: 1, head: HEAD })).rejects.toThrow(
      /another lane holds the release lease/,
    )
    expect(stale.runtime.lost).toHaveBeenCalled()
    expect(stale.gh).not.toHaveBeenCalled()
    const f = await fixture({ files: 'README.md\n.github/release-manager.md\n' })
    await expect(f.run('release_merge', { pr: 1, head: 'abc123' })).rejects.toThrow(/full commit/)
    await expect(f.run('release_merge', { pr: 1, head: HEAD })).rejects.toThrow(
      /changes .github\/release-manager.md/,
    )
    expect(f.gh).toHaveBeenCalledTimes(1)
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
