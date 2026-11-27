import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syntheticBrainBundle } from '../update/__fixtures__/brain-package'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  BRAIN_QUALIFICATION,
  BRAIN_WORKER_DIR,
  brainQualification,
  resolvePackagedBrainRuntime,
} from './packaged-runtime'

let root: string
const proof = brainQualification('darwin-arm64')
const versions = { platform: 'darwin', arch: 'arm64', version: `v${proof.node}` } as const
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'brain-readiness-'))
  mkdirSync(join(root, BRAIN_WORKER_DIR))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('requires more than the supported CPU or an on-disk qualification marker', () => {
  expect(resolvePackagedBrainRuntime(root, versions)).toBeNull()
  const marker = join(root, BRAIN_WORKER_DIR, BRAIN_QUALIFICATION)
  writeFileSync(marker, `${JSON.stringify(proof)}\n`)
  expect(resolvePackagedBrainRuntime(root, versions)).toBeNull()
  expect(resolvePackagedBrainRuntime(root, { ...versions, version: 'v22.23.4' })).toBeNull()
  expect(resolvePackagedBrainRuntime(root, { ...versions, arch: 'x64' })).toBeNull()
})

it('requires the guarded interactive Agent extension in a qualified package', () => {
  const resources = join(root, 'lib')
  mkdirSync(join(root, 'node/bin'), { recursive: true })
  syntheticBrainBundle(root)
  const guard = join(resources, 'brain-ext/brain-agent-guard.mjs')
  writeFileSync(guard, '')
  expect(resolvePackagedBrainRuntime(resources, versions)).not.toBeNull()
  rmSync(guard)
  expect(resolvePackagedBrainRuntime(resources, versions)).toBeNull()
})
