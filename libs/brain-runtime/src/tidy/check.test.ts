import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { runPrintMode } from '@phosphor/session-runtime/pi/print-mode'
import type { BrainTidyPair } from '@phosphor/shared/brain-tidy'
import { runModelCall, type ModelCallInput } from '../model-call'
import { parseTidy } from './parse'
import { TIDY_SYSTEM, tidyPrompt } from './prompt'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const memory = (id: string, branch: string | null = null) => ({
  type: 'memory' as const,
  id,
  sentence: 'Harbor bills weekly.',
  memoryType: 'fact' as const,
  scope: 'Harbor',
  branch,
  validFrom: null,
  validTo: null,
  observedAt: 0,
  entities: ['Harbor'],
  quotes: [],
})
const pairs: BrainTidyPair[] = [
  { suggestionId: 'same', subjects: [memory('a'), memory('b')] },
  { suggestionId: 'different', subjects: [memory('c'), memory('d', 'ledger-trial')] },
]
async function input(): Promise<ModelCallInput> {
  const directory = await mkdtemp(resolve('.tidy-check-test-'))
  directories.push(directory)
  return {
    directory,
    job: { id: 'tidy-fixture' },
    stage: 'tidy',
    part: 1,
    lane: {
      model: 'example/reader',
      thinking: 'medium',
      sessionId: 'harbor',
      cwd: directory,
      scope: 'Harbor',
      branch: null,
      leafId: null,
    },
    launch: {
      binaryPath: process.execPath,
      prefixArgs: [resolve('apps/desktop/e2e/fixtures/pi-stub.cjs')],
      env: { PI_CODING_AGENT_DIR: directory },
    },
    guardExtension: resolve('brain-fork-guard.mjs'),
    systemPrompt: TIDY_SYSTEM,
    prompt: tidyPrompt(pairs),
    signal: new AbortController().signal,
  }
}
it('uses the ordinary no-session no-tools launch and timeout for a lane-less check', async () => {
  const args = await input()
  const transport = vi.fn<typeof runPrintMode>(async (_binary, argv, options) => {
    expect(argv).toContain('--no-tools')
    expect(argv).toContain('--no-session')
    expect(argv).toContain('--no-mcp')
    expect(argv).toContain(args.guardExtension)
    expect(options.timeoutMs).toBe(600_000)
    expect(options.input).toBe(args.prompt)
    options.onStdout?.(
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '{"decisions":[]}' }] },
      }) + '\n',
    )
    return { stdout: '' }
  })
  expect((await runModelCall(args, transport)).text).toBe('{"decisions":[]}')
  expect(transport).toHaveBeenCalledOnce()
})
it('the deterministic pi stub recognizes Tidy and answers same versus different applicability', async () => {
  // Only the repository stub runs: no pi executable, provider or real agent directory.
  const result = await runModelCall(await input())
  expect(
    parseTidy(result.text, pairs, 'example/reader').judgements.map((j) => j.verdict.kind),
  ).toEqual(['same', 'different'])
})
