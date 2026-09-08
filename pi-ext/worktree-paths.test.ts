import { describe, expect, it } from 'vitest'
import { createToolCallGuard, worktreeCounterpart } from './worktree-paths'

/** The real shape: Phosphor puts worktrees inside the checkout they branch from. */
const MAIN = '/home/u/src/phosphor'
const CWD = '/home/u/src/phosphor/.phosphor/worktrees/read-composer'

const existsOnly =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path)

describe('worktreeCounterpart', () => {
  it('catches the observed leak: main-checkout path with a counterpart in the worktree', () => {
    const counterpart = worktreeCounterpart({
      cwd: CWD,
      mainRepoPath: MAIN,
      requestedPath: `${MAIN}/src/features/chat/composer/ContextMeter.tsx`,
      exists: existsOnly(`${CWD}/src/features/chat/composer/ContextMeter.tsx`),
    })
    expect(counterpart).toBe(`${CWD}/src/features/chat/composer/ContextMeter.tsx`)
  })

  it('leaves the worktree’s own files alone, though they are inside the main checkout too', () => {
    expect(
      worktreeCounterpart({
        cwd: CWD,
        mainRepoPath: MAIN,
        requestedPath: `${CWD}/src/lib/burnRate.ts`,
        exists: () => true,
      }),
    ).toBeNull()
  })

  it('leaves relative paths alone — pi already resolves them against the cwd', () => {
    expect(
      worktreeCounterpart({
        cwd: CWD,
        mainRepoPath: MAIN,
        requestedPath: 'src/lib/burnRate.ts',
        exists: () => true,
      }),
    ).toBeNull()
  })

  it('allows a main-checkout file with no counterpart in the worktree', () => {
    expect(
      worktreeCounterpart({
        cwd: CWD,
        mainRepoPath: MAIN,
        requestedPath: `${MAIN}/legacy/only-on-main.ts`,
        exists: existsOnly(`${MAIN}/legacy/only-on-main.ts`),
      }),
    ).toBeNull()
  })

  it('allows paths outside the repository entirely (pi docs, ~/.pi, /tmp)', () => {
    expect(
      worktreeCounterpart({
        cwd: CWD,
        mainRepoPath: MAIN,
        requestedPath: '/usr/lib/node_modules/pi/docs/extensions.md',
        exists: () => true,
      }),
    ).toBeNull()
  })

  it('does nothing at all when the session is not in a worktree', () => {
    expect(
      worktreeCounterpart({
        cwd: MAIN,
        mainRepoPath: null,
        requestedPath: '/somewhere/else/file.ts',
        exists: () => true,
      }),
    ).toBeNull()
  })

  it('works for a sibling worktree, not just a nested one', () => {
    const sibling = '/home/u/src/phosphor-feature'
    expect(
      worktreeCounterpart({
        cwd: sibling,
        mainRepoPath: MAIN,
        requestedPath: `${MAIN}/src/lib/burnRate.ts`,
        exists: existsOnly(`${sibling}/src/lib/burnRate.ts`),
      }),
    ).toBe(`${sibling}/src/lib/burnRate.ts`)
  })

  it('does not treat a sibling directory as being inside the main checkout', () => {
    expect(
      worktreeCounterpart({
        cwd: CWD,
        mainRepoPath: MAIN,
        // `/home/u/src/phosphor-notes` shares a prefix with `/home/u/src/phosphor`
        // as a string but is not inside it.
        requestedPath: '/home/u/src/phosphor-notes/src/lib/burnRate.ts',
        exists: () => true,
      }),
    ).toBeNull()
  })

  it('ignores an empty path', () => {
    expect(
      worktreeCounterpart({ cwd: CWD, mainRepoPath: MAIN, requestedPath: '', exists: () => true }),
    ).toBeNull()
  })
})

describe('createToolCallGuard', () => {
  const LEAKED = `${MAIN}/src/lib/burnRate.ts`
  const CORRECT = `${CWD}/src/lib/burnRate.ts`

  const guard = () =>
    createToolCallGuard({ detectMainRepo: () => MAIN, exists: existsOnly(CORRECT) })

  const call = (toolName: string, input: unknown) => ({ toolName, input })
  const ctx = { cwd: CWD }

  it('blocks the leak and names the file in the worktree', () => {
    const result = guard()(call('read', { path: LEAKED }), ctx)
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain(CORRECT)
  })

  it('honours a repeat of the same path — the deliberate cross-tree read', () => {
    const handler = guard()
    expect(handler(call('read', { path: LEAKED }), ctx)?.block).toBe(true)
    expect(handler(call('read', { path: LEAKED }), ctx)).toBeUndefined()
  })

  it('guards every path-bearing built-in, not just read', () => {
    for (const tool of ['read', 'write', 'edit', 'ls', 'grep', 'find']) {
      expect(guard()(call(tool, { path: LEAKED }), ctx)?.block).toBe(true)
    }
  })

  it('ignores tools it knows nothing about', () => {
    expect(guard()(call('bash', { path: LEAKED }), ctx)).toBeUndefined()
    expect(guard()(call('artifact_create', { path: LEAKED }), ctx)).toBeUndefined()
  })

  it('ignores calls with no usable path or no cwd', () => {
    expect(guard()(call('grep', { pattern: 'foo' }), ctx)).toBeUndefined()
    expect(guard()(call('read', { path: LEAKED }), {})).toBeUndefined()
  })

  it('detects the main checkout once per cwd', () => {
    let calls = 0
    const handler = createToolCallGuard({
      detectMainRepo: () => {
        calls++
        return MAIN
      },
      exists: existsOnly(CORRECT),
    })
    handler(call('read', { path: CORRECT }), ctx)
    handler(call('read', { path: LEAKED }), ctx)
    expect(calls).toBe(1)
  })
})
