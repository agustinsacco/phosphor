import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { adapterFixture } from './__fixtures__/adapter-fixture'
import { canonicalPrefs, laneAuthority } from './authority'
import { createBrainBridge } from './bridge'
import { createBrainIndexer } from './indexer'
import { createBrainWorking } from './working'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function fixture() {
  const f = await adapterFixture()
  cleanups.push(f.cleanup)
  const folder = join(f.root, 'augment sandbox')
  await mkdir(folder)
  return { ...f, folder }
}

it('enrolls a plain folder and its symlink as one branchless workspace', async () => {
  const f = await fixture()
  const alias = join(f.root, 'alias')
  await symlink(f.folder, alias, 'dir')
  const prefs = await canonicalPrefs({
    ...f.snapshot.prefs,
    workspaces: [f.folder, alias, f.scope],
  })
  expect(prefs.workspaces).toEqual([f.folder, f.scope])
  expect(await laneAuthority(alias)).toEqual({ scope: f.folder, branch: null })
})

it('does not enroll a regular file as a workspace', async () => {
  const f = await fixture()
  const file = join(f.folder, 'not-a-folder')
  await writeFile(file, 'synthetic')
  await expect(canonicalPrefs({ ...f.snapshot.prefs, workspaces: [file] })).rejects.toThrow(
    'directory',
  )
})

it('recognizes an unborn Git branch without misclassifying its repository', async () => {
  const f = await fixture()
  execFileSync('git', ['init', '-b', 'main', f.folder], { stdio: 'ignore' })
  expect(await laneAuthority(f.folder)).toEqual({ scope: f.folder, branch: 'main' })
})

it('keeps detached Git checkouts unavailable instead of reclassifying them as plain folders', async () => {
  const f = await fixture()
  execFileSync('git', ['-C', f.scope, 'checkout', '--detach'], { stdio: 'ignore' })
  await expect(laneAuthority(f.scope)).rejects.toThrow('known Git branch')
})

it('does not let inherited Git variables choose another workspace branch', async () => {
  const f = await fixture()
  const other = join(f.root, 'other-repo')
  execFileSync('git', ['clone', f.scope, other], { stdio: 'ignore' })
  execFileSync('git', ['-C', other, 'checkout', '-b', 'foreign'], { stdio: 'ignore' })
  vi.stubEnv('GIT_DIR', join(other, '.git'))
  vi.stubEnv('GIT_WORK_TREE', other)
  expect(await laneAuthority(f.scope)).toEqual({ scope: f.scope, branch: 'main' })
})

it('refuses broken Git metadata rather than treating it as a branchless folder', async () => {
  const f = await fixture()
  await writeFile(join(f.folder, '.git'), 'gitdir: /missing-brain-test-gitdir\n')
  await expect(laneAuthority(f.folder)).rejects.toThrow()
})

it('admits branchless recall and still rejects another workspace or a claimed branch', async () => {
  const f = await fixture()
  const snapshot = f.engine.setPrefs({ ...f.snapshot.prefs, workspaces: [f.folder] })
  const evidence = f.engine.capture({
    ...f.evidence,
    scope: f.folder,
    branch: null,
    entryId: 'folder-entry',
  })!
  const bridge = await createBrainBridge({ allowed: async () => false, invoke: async () => null })
  cleanups.push(() => bridge.close())
  const indexer = createBrainIndexer(f.store, f.embeds)
  cleanups.push(async () => indexer.dispose())
  const working = createBrainWorking(f.options, f.store, bridge, indexer)
  cleanups.push(async () => working.dispose())
  const client = Object.assign(new EventEmitter(), {
    request: vi.fn(async (command: { type: string }) => ({
      success: true,
      data: command.type === 'get_state' ? { sessionId: 'folder-native' } : { entries: [] },
    })),
  })
  const live: LiveSession = {
    sessionId: 'folder-live',
    workspacePath: f.folder,
    client: client as unknown as PiRpcClient,
  }
  f.lives.set(live.sessionId, live)
  const augmentation = await working.memory.prepare({ workspacePath: f.folder })
  expect(augmentation).toBeDefined()
  await augmentation!.onCreated(live)
  expect(f.options.onError).not.toHaveBeenCalled()
  const capability = {
    kind: 'working' as const,
    scope: f.folder,
    policyEpoch: snapshot.policyEpoch,
    sessionId: live.sessionId,
  }
  expect(await working.invoke(capability, 'read', { evidenceId: evidence.id })).toEqual(evidence)
  await expect(
    working.invoke(capability, 'search', { query: 'Atlas', branch: 'main' }),
  ).rejects.toThrow('widened')
  live.workspacePath = f.scope
  await expect(working.invoke(capability, 'read', { evidenceId: evidence.id })).rejects.toThrow(
    'scope unavailable',
  )
})
