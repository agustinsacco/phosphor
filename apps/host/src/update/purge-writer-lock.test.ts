import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HOST_BRAIN_WRITER_LOCK } from '../brain/writer-lock'
import { holdPurgeWriterLock, WRITER_REPAIR } from './purge-writer-lock'

it('does not publish a purge lock through an interrupted recovery gate with no holder', async () => {
  const state = mkdtempSync(join(tmpdir(), 'brain-purge-recovery-'))
  try {
    const path = join(state, HOST_BRAIN_WRITER_LOCK)
    const gate = `${path}-recovery`
    mkdirSync(gate, { mode: 0o700 })
    utimesSync(gate, new Date(0), new Date(0))
    await expect(holdPurgeWriterLock(state, process.getuid?.())).rejects.toThrow(WRITER_REPAIR)
    expect(existsSync(gate)).toBe(true)
    expect(existsSync(path)).toBe(false)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
