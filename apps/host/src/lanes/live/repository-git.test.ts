import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRepositoryGit, type RepositoryGitOptions } from './repository-git'

const repo = (path: string) => ({ id: path.slice(1).padEnd(16, '0'), name: path, path })
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
let clock = 0
const setup = (probe: RepositoryGitOptions['probe'], extra: Partial<RepositoryGitOptions> = {}) => {
  const changed = vi.fn()
  return { changed, git: createRepositoryGit({ probe, changed, now: () => clock, ...extra }) }
}
afterEach(() => {
  clock = 0
  vi.useRealTimers()
})

describe('createRepositoryGit', () => {
  it('lists without the field until git answers, then republishes once with it', async () => {
    const answers: Record<string, boolean | null> = { '/a': true, '/b': false, '/c': null }
    const { git, changed } = setup(async (path) => answers[path] ?? null)
    const list = [repo('/a'), repo('/b'), repo('/c')]
    expect(git.annotate(list)).toStrictEqual(list)
    await settle()
    expect(changed).toHaveBeenCalledTimes(1)
    // The republished listing falls inside the window: no second round, no loop.
    expect(git.annotate(list)).toStrictEqual([
      { ...repo('/a'), git: true },
      { ...repo('/b'), git: false },
      repo('/c'),
    ])
    await settle()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('asks again only after the window, or at once for a new folder', async () => {
    const probe = vi.fn(async () => false)
    const { git } = setup(probe)
    git.annotate([repo('/a')])
    await settle()
    git.annotate([repo('/a')])
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)
    git.annotate([repo('/a'), repo('/b')])
    await settle()
    expect(probe).toHaveBeenCalledTimes(3)
    clock = 10_000
    git.annotate([repo('/a'), repo('/b')])
    await settle()
    expect(probe).toHaveBeenCalledTimes(5)
  })

  it('notices a later git init on a listing after the window', async () => {
    let tracked = false
    const { git, changed } = setup(async () => tracked)
    git.annotate([repo('/a')])
    await settle()
    tracked = true
    clock = 10_000
    expect(git.annotate([repo('/a')])).toStrictEqual([{ ...repo('/a'), git: false }])
    await settle()
    expect(changed).toHaveBeenCalledTimes(2)
    expect(git.annotate([repo('/a')])).toStrictEqual([{ ...repo('/a'), git: true }])
  })

  it('keeps the last answer through unknown ones, and forgets folders that leave', async () => {
    let answer: boolean | null = false
    const { git, changed } = setup(async () => {
      if (answer === null) throw new Error('git missing')
      return answer
    })
    git.annotate([repo('/a')])
    await settle()
    answer = null
    clock = 10_000
    git.annotate([repo('/a')])
    await settle()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(git.annotate([repo('/a')])).toStrictEqual([{ ...repo('/a'), git: false }])
    git.annotate([repo('/b')])
    await settle()
    expect(git.annotate([repo('/a')])).toStrictEqual([repo('/a')])
  })

  it('runs one round at a time and takes the latest queued listing after it', async () => {
    const pending: ((answer: boolean) => void)[] = []
    const probe = vi.fn((_path: string) => new Promise<boolean>((done) => pending.push(done)))
    const { git } = setup(probe)
    git.annotate([repo('/a')])
    git.annotate([repo('/a'), repo('/b')])
    git.annotate([repo('/a'), repo('/c')])
    expect(probe).toHaveBeenCalledTimes(1)
    pending.shift()!(true)
    await settle()
    expect(probe.mock.calls.map(([path]) => path)).toStrictEqual(['/a', '/a', '/c'])
    for (const done of pending.splice(0)) done(true)
  })

  it('counts a hung probe as unknown, never asks that folder twice at once, survives a throwing republish', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async (path: string) =>
      path === '/slow' ? new Promise<boolean>(() => {}) : false,
    )
    const { git, changed } = setup(probe, { timeoutMs: 50 })
    changed.mockImplementation(() => {
      throw new Error('closed')
    })
    git.annotate([repo('/slow'), repo('/b')])
    await vi.advanceTimersByTimeAsync(50)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(git.annotate([repo('/slow'), repo('/b')])).toStrictEqual([
      repo('/slow'),
      { ...repo('/b'), git: false },
    ])
    clock = 10_000
    git.annotate([repo('/slow'), repo('/b')])
    await vi.advanceTimersByTimeAsync(50)
    expect(probe.mock.calls.map(([path]) => path)).toStrictEqual(['/slow', '/b', '/b'])
  })

  it('asks at most eight folders at once', async () => {
    let running = 0
    let peak = 0
    const { git } = setup(async () => {
      peak = Math.max(peak, ++running)
      await new Promise((resolve) => setTimeout(resolve, 1))
      running--
      return true
    })
    git.annotate(Array.from({ length: 20 }, (_, i) => repo(`/r${i}`)))
    await vi.waitFor(() => expect(running).toBe(0))
    await settle()
    expect(peak).toBe(8)
  })

  it('without a probe, never asks and lists the field-free summaries', () => {
    const { git, changed } = setup(undefined)
    expect(git.annotate([repo('/a')])).toStrictEqual([repo('/a')])
    expect(changed).not.toHaveBeenCalled()
  })
})
