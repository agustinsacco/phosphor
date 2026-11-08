import { mkdtemp, mkdir, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { createLearningHost, type LearningHostOptions } from './learning-host'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'learning-recovery-')))
  roots.push(root)
  const directory = join(root, 'learning')
  await mkdir(directory)
  const options: LearningHostOptions = { directory, extensionPath: join(root, 'brain-learning-carrier.mjs'),
    sessionsRoot: join(root, 'sessions'), paths: createSessionPathRuntime(), registry: { list: () => [], get: () => undefined },
    sessions: { create: vi.fn(async () => { throw new Error('Unexpected spawn') }), disposeBrain: vi.fn(async () => {}) },
    resolve: vi.fn(async () => { throw new Error('Unexpected auth resolution') }), onError: vi.fn() }
  return { root, directory, options, host: createLearningHost(options) }
}
async function interrupted(directory: string, name: string, writerState?: string) {
  const path = join(directory, `learning-${name}`)
  await mkdir(path)
  const marker = { version: 1, kind: 'brain-learning-root', jobId: 'preview-job', nonce: 'a'.repeat(64), writerState }
  await writeFile(join(path, 'owner.json'), JSON.stringify(marker))
  await writeFile(join(path, 'source.jsonl'), JSON.stringify({ type: 'custom', customType: 'phosphor-brain-owner', data: { kind: 'brain', jobId: 'preview-job' } }) + '\n')
  return path
}
it('fresh admission recovers an interrupted preview-only source root before resolving or spawning another carrier', async () => {
  const f = await fixture()
  const previous = await interrupted(f.directory, 'preview', 'never-started')
  await f.host.prepare({ workspacePath: '/not-an-existing-workspace', sessionPath: '/not-an-existing-session' }, 'next-job', new AbortController().signal).catch(() => undefined)
  await expect(readFile(join(previous, 'source.jsonl'))).rejects.toThrow()
  expect(f.options.resolve).not.toHaveBeenCalled()
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})
it.each(['never-started', 'stopped'])('explicit recovery and shutdown purge proven %s roots even without a job receipt', async state => {
  const f = await fixture()
  await interrupted(f.directory, 'known', state)
  const host = f.host as typeof f.host & { recover(): Promise<void>; dispose(): Promise<void> }
  await host.recover(); await host.recover(); await host.dispose()
  expect(await readdir(f.directory)).toEqual([])
})
it.each(['possibly-running', undefined, 'unsupported'])('retains uncertain or malformed roots visibly: %s', async state => {
  const f = await fixture(), previous = await interrupted(f.directory, 'uncertain', state)
  const original = await readFile(join(previous, 'source.jsonl'), 'utf8')
  const host = f.host as typeof f.host & { recover(): Promise<void>; dispose(): Promise<void> }
  await expect(host.recover()).rejects.toThrow(/retained|Retained/)
  await expect(host.dispose()).rejects.toThrow(/retained|Retained/)
  await expect(f.host.prepare({ workspacePath: '/missing', sessionPath: '/missing' }, 'job', new AbortController().signal)).rejects.toThrow(/retained|Retained/)
  expect(await readFile(join(previous, 'source.jsonl'), 'utf8')).toBe(original)
  expect(f.options.sessions.disposeBrain).not.toHaveBeenCalled()
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})
it('preserves foreign markers, malformed JSON and root/file symlinks without following their targets', async () => {
  const f = await fixture(), previous = await interrupted(f.directory, 'foreign', 'stopped')
  const marker = join(previous, 'owner.json'), source = join(previous, 'source.jsonl')
  const original = await readFile(source, 'utf8')
  const host = f.host as typeof f.host & { recover(): Promise<void> }
  await writeFile(marker, '{malformed')
  await expect(host.recover()).rejects.toThrow(/retained|Retained/)
  await rm(marker)
  await symlink(source, marker)
  await expect(host.recover()).rejects.toThrow(/retained|Retained/)
  await rm(previous, { recursive: true })
  const target = join(f.root, 'foreign-target')
  await mkdir(target); await writeFile(join(target, 'untouched'), original)
  await symlink(target, previous)
  await expect(host.recover()).rejects.toThrow(/retained|Retained/)
  expect(await readFile(join(target, 'untouched'), 'utf8')).toBe(original)
})
