import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createSessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { admitLearningSource } from './learning-source-admission'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'learning-admission-'))
  roots.push(root)
  const workspacePath = join(root, 'folder'), sessionsRoot = join(root, 'sessions')
  await mkdir(workspacePath)
  const directory = sessionDirForCwd(workspacePath, sessionsRoot)
  await mkdir(directory, { recursive: true })
  const sessionId = '01a12345-1234-4234-8234-123456789abc'
  const sessionPath = join(directory, `2026-01-01_${sessionId}.jsonl`)
  const header = { type: 'session', version: 3, id: sessionId, cwd: workspacePath }
  const entries = [
    { type: 'model_change', id: 'm', parentId: null, provider: 'openai', modelId: 'exact' },
    { type: 'thinking_level_change', id: 't', parentId: 'm', thinkingLevel: 'off' },
    { type: 'message', id: 'u', parentId: 't', message: { role: 'user', content: 'task' } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'preserve' }, { type: 'text', text: 'finished' }], stopReason: 'stop', provider: 'openai', model: 'exact', api: 'openai-responses' } },
  ]
  const text = () => [header, ...entries].map(x => JSON.stringify(x)).join('\n') + '\n'
  await writeFile(sessionPath, text())
  const snapshotPath = join(root, 'copy.jsonl')
  const runtime = { sessionsRoot, paths: createSessionPathRuntime(), registry: { list: () => [], get: () => undefined } }
  return { root, header, entries, text, sessionPath, workspacePath, snapshotPath, runtime }
}
it('admits a real folder session under the path lock without changing its last assistant or thinking', async () => {
  const f = await fixture(), before = await readFile(f.sessionPath, 'utf8')
  const admitted = await admitLearningSource(f.runtime, f, f.snapshotPath, 'job', new AbortController().signal)
  expect(admitted.selection).toEqual({ provider: 'openai', modelId: 'exact', api: 'openai-responses', thinkingLevel: 'off' })
  expect(admitted.frozen.lines.at(-1)).toContain('preserve')
  expect(admitted.scope).toBe(f.workspacePath)
  expect(await readFile(f.sessionPath, 'utf8')).toBe(before)
  expect(await readFile(f.snapshotPath, 'utf8')).toContain('phosphor-brain-owner')
})
it('refuses arbitrary paths, symlinks and header workspace authority', async () => {
  const f = await fixture(), signal = new AbortController().signal
  const arbitrary = join(f.root, 'arbitrary.jsonl')
  await writeFile(arbitrary, f.text())
  await expect(admitLearningSource(f.runtime, { ...f, sessionPath: arbitrary }, f.snapshotPath, 'job', signal)).rejects.toThrow()
  const alias = join(f.root, 'alias.jsonl')
  await symlink(f.sessionPath, alias)
  await expect(admitLearningSource(f.runtime, { ...f, sessionPath: alias }, f.snapshotPath, 'job', signal)).rejects.toThrow()
  f.header.cwd = f.root
  await writeFile(f.sessionPath, f.text())
  await expect(admitLearningSource(f.runtime, f, f.snapshotPath, 'job', signal)).rejects.toThrow()
})
it.each(['toolUse', 'error', 'aborted'])('refuses an unsettled offline final assistant %s', async stopReason => {
  const f = await fixture()
  f.entries.at(-1)!.message!.stopReason = stopReason
  await writeFile(f.sessionPath, f.text())
  await expect(admitLearningSource(f.runtime, f, f.snapshotPath, 'job', new AbortController().signal)).rejects.toThrow('completed')
})
it('refuses private ownership even on an unrelated branch and torn tails', async () => {
  const f = await fixture(), signal = new AbortController().signal
  await writeFile(f.sessionPath, f.text() + JSON.stringify({ type: 'custom', id: 'private', parentId: null, customType: 'phosphor-brain-owner', data: { kind: 'brain', jobId: 'other' } }) + '\n')
  await expect(admitLearningSource(f.runtime, f, f.snapshotPath, 'job', signal)).rejects.toThrow()
  await writeFile(f.sessionPath, f.text() + '{')
  await expect(admitLearningSource(f.runtime, f, f.snapshotPath, 'job', signal)).rejects.toThrow()
})
