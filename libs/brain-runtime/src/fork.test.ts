import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import { runFork, type ForkInput } from './fork'
import { FakeBrainStore, HARBOR_JOB } from './__fixtures__/fake-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })))
})
async function input(): Promise<ForkInput> {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-fork-'))
  directories.push(directory)
  return {
    directory,
    job: new FakeBrainStore().enqueue(HARBOR_JOB, 'queued'),
    lane: {
      sessionId: 'harbor-lane',
      cwd: '/made-up/harbor',
      model: 'example/fast',
      thinking: 'high',
      scope: '/projects/harbor',
      branch: 'billing',
      leafId: 'leaf',
    },
    launch: {
      binaryPath: '/binary/pi',
      prefixArgs: ['entry.js'],
      env: { HARBOR_ACCOUNT: 'fake-account' },
    },
    guardExtension: '/extensions/brain-fork-guard.mjs',
    prompt: 'Extract Harbor knowledge.',
    signal: new AbortController().signal,
  }
}
const event = (text: string, stopReason = 'stop') =>
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason,
      content: [
        { type: 'thinking', thinking: 'not an answer' },
        { type: 'text', text },
      ],
      usage: { totalTokens: 120, cost: { total: 0.001 } },
    },
  })

it('forks privately with lane args/env, parses streaming LF records and removes its isolated directory', async () => {
  const args = await input()
  const run = vi.fn<typeof runPrintMode>().mockImplementation(async (_binary, _args, options) => {
    expect(await stat(options.cwd)).toBeTruthy()
    // A megabyte of deltas must not be captured by the transport or mistaken for the final answer.
    for (let i = 0; i < 100; i++)
      options.onStdout?.(
        JSON.stringify({ type: 'message_update', delta: 'x'.repeat(10000) }) + '\n',
      )
    const stream = event('earlier') + '\n' + event('Harbor\u2028billing')
    for (let at = 0; at < stream.length; at += 13) options.onStdout?.(stream.slice(at, at + 13))
    return { stdout: 'Never parse this capture.' }
  })
  expect(await runFork(args, run)).toEqual({
    text: 'Harbor\u2028billing',
    usage: { tokens: 120, cost: 0.001 },
  })
  const forkDir = join(args.directory, 'forks', args.job.id)
  expect(run.mock.calls[0]).toEqual([
    '/binary/pi',
    [
      'entry.js',
      '-p',
      '--mode',
      'json',
      '--fork',
      HARBOR_JOB.sessionPath,
      '--session-dir',
      forkDir,
      '--model',
      'example/fast',
      '--thinking',
      'low',
      '--no-tools',
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-themes',
      '--no-approve',
      '--offline',
      '-e',
      '/extensions/brain-fork-guard.mjs',
      'Extract Harbor knowledge.',
    ],
    expect.objectContaining({
      cwd: forkDir,
      timeoutMs: 150000,
      maxOutputBytes: 0,
      stderr: 'ignore',
      signal: args.signal,
      env: {
        HARBOR_ACCOUNT: 'fake-account',
        PI_CLAUDE_CLI_KEEPALIVE_MS: '0',
        PI_OFFLINE: '1',
        PI_CLAUDE_CLI_EPHEMERAL: '1',
        PI_CLAUDE_CLI_STATE_DIR: join(forkDir, 'provider'),
      },
    }),
  ])
  expect(await stat(forkDir).catch(() => null)).toBeNull()
})

it.each(['error', 'aborted'])('fails on assistant stop reason %s and cleans up', async (reason) => {
  const args = await input()
  const run: typeof runPrintMode = async (_binary, _args, options) => {
    options.onStdout?.(event('not saved', reason) + '\n')
    return { stdout: '' }
  }
  await expect(runFork(args, run)).rejects.toThrow(reason)
  expect(await stat(join(args.directory, 'forks', args.job.id)).catch(() => null)).toBeNull()
})

it('uses an existing lane cwd and preserves low thinking, but fails absent text and transport errors', async () => {
  const args = await input()
  args.lane.cwd = args.directory
  args.lane.thinking = 'minimal'
  const run = vi.fn<typeof runPrintMode>().mockResolvedValue({ stdout: '' })
  await expect(runFork(args, run)).rejects.toThrow('no text')
  expect(run.mock.calls[0]![1]).toContain('minimal')
  expect(run.mock.calls[0]![2].cwd).toBe(args.directory)
  run.mockResolvedValue({ stdout: '', reason: 'timeout', error: 'sensitive provider details' })
  await expect(runFork(args, run)).rejects.toThrow('Knowledge extraction timeout.')
  args.signal = AbortSignal.abort()
  await expect(runFork(args, run)).rejects.toThrow()
})

it('runs as a one-shot even when the lane parks its Claude process', async () => {
  const args = await input()
  args.launch.env = { PI_CLAUDE_CLI_KEEPALIVE_MS: '3600000', PI_CLAUDE_CLI_EPHEMERAL: '0' }
  const run = vi.fn<typeof runPrintMode>().mockImplementation(async (_binary, _args, options) => {
    options.onStdout?.(event('Harbor') + '\n')
    return { stdout: '' }
  })
  await runFork(args, run)
  expect(run.mock.calls[0]![2].env).toMatchObject({
    PI_CLAUDE_CLI_KEEPALIVE_MS: '0',
    PI_CLAUDE_CLI_EPHEMERAL: '1',
  })
})
