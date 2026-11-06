import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { SessionRegistry } from '@phosphor/session-runtime/pi/session-registry'
import { createSessionStartup } from '@phosphor/session-runtime/pi/session-startup'
import { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import type { SessionPolicyRuntime } from '@phosphor/session-runtime/pi/session-policy'
import type { BrainExecutionProfile } from '@phosphor/session-runtime/pi/brain-execution-profile'
import { brainOwnerFromEntry } from '@phosphor/session-runtime/pi/brain-session-owner'
import { verifyBrainTools } from './brain-tool-audit'
import { assertTranscriptOwnership, plannedTranscriptExists } from '../brain/transcripts'

const entry = process.env.PHOSPHOR_BRAIN_PI_ENTRY
function entryRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid entry')
  return value as Record<string, unknown>
}
const bundler = resolve(import.meta.dirname, '../../../../tools/scripts/build-brain-extensions.mjs')
const { buildBrainExtensions } = (await import(pathToFileURL(bundler).href)) as {
  buildBrainExtensions(options: { root: string; outDir: string }): Promise<void>
}
const forbidden = (): never => {
  throw new Error('Ordinary startup policy must not run')
}
function runtime() {
  let inference = 0
  const registry = new SessionRegistry({
    assertCanStart: () => {},
    createClient: (options) => new PiRpcClient(options, { log: () => {}, isClosing: () => false }),
  })
  registry.on('created', (live) =>
    live.client.on('event', (event) => {
      if (event.type === 'agent_start') inference++
    }),
  )
  const startup = createSessionStartup({
    registry,
    resolveWorkspace: forbidden,
    launch: forbidden,
    policy: new Proxy({} as SessionPolicyRuntime, { get: () => forbidden }),
    log: () => {},
    recordWorkspace: forbidden,
    budget: { watch: forbidden, read: forbidden, paused: () => false },
    accounts: { remember: forbidden, forget: () => {}, hold: forbidden },
  })
  const service = createSessionService({
    registry,
    paths: createSessionPathRuntime(),
    isStub: () => false,
    spawn: (options, _delivery, execution) => startup(options, () => () => {}, execution),
    packages: forbidden,
    readBudget: forbidden,
    withBudgetCompaction: forbidden,
    forgetAccount: () => {},
    routines: {
      owns: () => false,
      sessionForPath: () => undefined,
      observe: forbidden,
      cancel: forbidden,
    },
  })
  return { registry, service, inference: () => inference }
}

it.skipIf(!entry)(
  'audits real isolated pi without inference or evidence delivery',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'brain-real-pi-')))
    const h = runtime()
    const profile: BrainExecutionProfile = {
      owner: { kind: 'brain', jobId: 'synthetic-audit' },
      cwd: join(root, 'cwd'),
      agentDir: join(root, 'config'),
      sessionDir: join(root, 'sessions'),
      binaryPath: process.env.PHOSPHOR_BRAIN_PI_SANDBOX
        ? '/usr/bin/sandbox-exec'
        : process.execPath,
      prefixArgs: process.env.PHOSPHOR_BRAIN_PI_SANDBOX
        ? ['-f', process.env.PHOSPHOR_BRAIN_PI_SANDBOX, process.execPath, entry!]
        : [entry!],
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      processorExtension: join(root, 'brain-ext', 'brain-processor.mjs'),
      env: {
        PATH: process.env.PATH ?? '',
        ANTHROPIC_API_KEY: 'synthetic-no-inference-key',
        PHOSPHOR_BRAIN_ENDPOINT: join(root, 'unused.sock'),
        PHOSPHOR_BRAIN_TOKEN: 'a'.repeat(64),
      },
    }
    try {
      await Promise.all(
        [profile.cwd, profile.agentDir, profile.sessionDir].map((dir) => mkdir(dir)),
      )
      await buildBrainExtensions({
        root: resolve(import.meta.dirname, '../../../..'),
        outDir: join(root, 'brain-ext'),
      })
      const signal = AbortSignal.timeout(15_000)
      const info = await h.service.create({ workspacePath: profile.cwd }, undefined, {
        brain: profile,
        signal,
      })
      const live = h.registry.get(info.sessionId)!
      await verifyBrainTools(live.client, profile.owner.jobId, profile.processorExtension, signal)
      const entries = await live.client.request({ type: 'get_entries' })
      const rows = entries.success ? entries.data?.entries.map(entryRecord) : undefined
      expect(rows).toBeDefined()
      expect(rows?.some((entry) => entry.type === 'message')).toBe(false)
      expect(h.inference()).toBe(0)
      // Pi buffers this owner entry until its first assistant message; no disk write here.
      expect(rows?.map(brainOwnerFromEntry).filter(Boolean)).toEqual([profile.owner])
      assertTranscriptOwnership(rows, profile.owner.jobId)
      expect(await plannedTranscriptExists(live.client.sessionFile!, profile.sessionDir)).toBe(
        false,
      )
      await expect(
        h.service.command(info.sessionId, { type: 'bash', command: 'printf forbidden' }),
      ).rejects.toThrow(/Brain/)
      await h.service.disposeBrain(info.sessionId, profile.owner)
      expect(h.registry.list()).toEqual([])
    } finally {
      await h.registry.disposeAll()
      await rm(root, { recursive: true, force: true })
    }
  },
  25_000,
)
