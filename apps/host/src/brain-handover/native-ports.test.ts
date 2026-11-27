import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_MODEL } from '@phosphor/brain-runtime/embedding/model-manifest'
import {
  BRAIN_QUALIFICATION,
  BRAIN_WORKER_DIR,
  brainQualification,
} from '../brain/packaged-runtime'
import { createBrainHandoverNativePorts } from './native-ports'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
const temp = (name: string) => {
  const folder = mkdtempSync(join(tmpdir(), `${name}-`))
  folders.push(folder)
  return folder
}
const proof = brainQualification('darwin-arm64')
const runtime = { platform: 'darwin', arch: 'arm64', version: `v${proof.node}` } as const
/** The files `resolvePackagedBrainRuntime` requires, relative to `brain-workers/`. */
const PACKAGED = [
  'brain-search-worker.js',
  'brain-embedding-worker.js',
  'package.json',
  '../brain-ext/brain.mjs',
  '../brain-ext/brain-curator.mjs',
  '../brain-ext/brain-fork-guard.mjs',
  '../brain-ext/brain-agent-guard.mjs',
  '../skills/brain/SKILL.md',
  '../node_modules/brain-transformers/dist/transformers.node.mjs',
  '../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
  '../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
  '../node_modules/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node',
  '../node_modules/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib',
]
/** A synthetic qualified bundle: the marker and every file it names, all empty. */
function bundle(): string {
  const root = temp('harbor-bundle')
  const dir = join(root, BRAIN_WORKER_DIR)
  for (const file of [...PACKAGED, BRAIN_QUALIFICATION]) {
    const path = join(dir, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file === BRAIN_QUALIFICATION ? `${JSON.stringify(proof)}\n` : '')
  }
  return root
}
function pi(): string {
  const path = join(temp('harbor-pi'), 'pi')
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o700)
  return path
}
function ports(over: Partial<Parameters<typeof createBrainHandoverNativePorts>[0]> = {}) {
  const spawn = vi.fn(() => {
    throw new Error('no worker may start')
  })
  const fetch = vi.fn(() => Promise.reject(new Error('no network')))
  const native = createBrainHandoverNativePorts({
    resourceRoot: bundle(),
    pi: { binaryPath: pi(), prefixArgs: [] },
    sessionsRoot: temp('harbor-sessions'),
    agentBinding: { read: () => null, bind: () => undefined },
    log: () => undefined,
    runtime,
    spawn,
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...over,
  })
  return { native, spawn, fetch }
}

describe('the Host’s Brain handover readiness', () => {
  it('pins the model the Host will accept: the release manifest, file for file', () => {
    expect(ports().native.embeddingModel).toEqual({
      directoryName: EMBEDDING_MODEL.directoryName,
      files: EMBEDDING_MODEL.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    })
  })

  it('preflight: a qualified bundle and a runnable pi, nothing else read', async () => {
    expect(await ports().native.readerReadiness()).toBe('qualified')
  })

  it('preflight refuses an unqualified bundle or another Node', async () => {
    expect(await ports({ resourceRoot: temp('empty') }).native.readerReadiness()).toBe(
      'unqualified',
    )
    expect(
      await ports({ runtime: { ...runtime, version: 'v22.23.4' } }).native.readerReadiness(),
    ).toBe('unqualified')
  })

  it('preflight refuses a missing or relative pi', async () => {
    const missing = { binaryPath: '/made-up/pi', prefixArgs: [] }
    expect(await ports({ pi: missing }).native.readerReadiness()).toBe('unavailable')
    expect(await ports({ pi: { binaryPath: 'pi', prefixArgs: [] } }).native.readerReadiness()).toBe(
      'unavailable',
    )
    const node = { binaryPath: pi(), prefixArgs: ['/made-up/pi.js'] }
    expect(await ports({ pi: node }).native.readerReadiness()).toBe('unavailable')
  })

  it('the model probe never downloads and never starts a worker on missing files', async () => {
    const { native, spawn, fetch } = ports()
    expect(await native.probeModel(join(temp('harbor-embeddings'), 'embeddings'))).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('the model probe refuses files that do not match the pinned hashes', async () => {
    const { native, spawn, fetch } = ports()
    const directory = temp('harbor-embeddings')
    const model = join(directory, 'embedding-models', EMBEDDING_MODEL.directoryName)
    for (const file of EMBEDDING_MODEL.files) {
      mkdirSync(dirname(join(model, file.path)), { recursive: true })
      writeFileSync(join(model, file.path), 'Ledger')
    }
    expect(await native.probeModel(directory)).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('the model probe refuses outright on an unqualified bundle', async () => {
    const { native, spawn } = ports({ resourceRoot: temp('empty') })
    expect(await native.probeModel(temp('harbor-embeddings'))).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })
})
