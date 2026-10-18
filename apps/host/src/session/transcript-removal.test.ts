import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { unlinkTranscript } from './transcript-removal'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'host-transcript-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  const folder = sessionDirForCwd(dir)
  mkdirSync(folder, { recursive: true })
  file = join(folder, 'a.jsonl')
  writeFileSync(file, '{}\n')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})
it('passes canonical identity to trash and tolerates disappearance during trash', async () => {
  const remove = vi.fn(async () => {
    throw { code: 'ENOENT' }
  })
  await expect(unlinkTranscript(file, remove)).resolves.toBeUndefined()
  expect(remove).toHaveBeenCalledExactlyOnceWith(file)
})
it('propagates trash failures unchanged, including non-errno thrown values', async () => {
  for (const error of [new Error('trash failed'), { code: 'EACCES' }, null, 'failure']) {
    await expect(
      unlinkTranscript(file, async () => {
        throw error
      }),
    ).rejects.toBe(error)
  }
})
it('never calls trash for a symlink or missing path', async () => {
  const link = file.replace('a.jsonl', 'link.jsonl')
  symlinkSync(file, link)
  const remove = vi.fn(async () => {})
  await expect(unlinkTranscript(link, remove)).rejects.toThrow('not a pi session file')
  await unlinkTranscript(file.replace('a.jsonl', 'absent.jsonl'), remove)
  await unlinkTranscript(join(dir, 'absent/a.jsonl'), remove)
  expect(remove).not.toHaveBeenCalled()
})
