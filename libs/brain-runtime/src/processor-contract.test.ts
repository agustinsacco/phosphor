import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { claimBrainSession } from '@phosphor/pi-extensions/brain-processor'
import { brainOwnerFromEntry } from '@phosphor/session-runtime/pi/brain-session-owner'
import { prepareBrainSpawnOptions } from '@phosphor/session-runtime/pi/brain-execution-profile'

it('recognizes the actual processor extension ownership marker in the runtime scanner', () => {
  let entry: Record<string, unknown> = {}
  const result = claimBrainSession(
    {
      appendEntry(customType, data) {
        entry = { type: 'custom', customType, data }
      },
    },
    [],
    'job-1',
  )
  expect(result).toBe('owned')
  expect(brainOwnerFromEntry(entry)).toEqual({ kind: 'brain', jobId: 'job-1' })
})

it('admits the standalone bundled processor resource rather than a monorepo source file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-profile-wire-'))
  const cwd = join(root, 'work'),
    agentDir = join(root, 'config'),
    sessionDir = join(root, 'sessions')
  try {
    await Promise.all([cwd, agentDir, sessionDir].map((path) => mkdir(path)))
    const processorExtension = join(root, 'brain-processor.mjs')
    const options = await prepareBrainSpawnOptions(
      { workspacePath: cwd },
      {
        owner: { kind: 'brain', jobId: 'job-1' },
        cwd,
        agentDir,
        sessionDir,
        binaryPath: process.execPath,
        provider: 'synthetic',
        modelId: 'test',
        processorExtension,
        providerExtension: join(root, 'synthetic-provider.mjs'),
      },
    )
    expect(options.extensions).toContain(processorExtension)
    expect(options.inheritEnv).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
