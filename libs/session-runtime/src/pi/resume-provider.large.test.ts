import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendEntries,
  assistantEntry,
  writeLargeTranscript,
} from './__fixtures__/large-transcript'
import { resumeProvider } from './resume-provider'
import { prepareProviderAccount } from './session-provider'

// More than the 64 MiB a whole-file read once allowed.
const BULK_MIB = 66
let root: string
let base: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'phosphor-resume-provider-large-'))
  base = join(root, 'base.jsonl')
  writeLargeTranscript(base, BULK_MIB)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function transcript(name: string, entries: readonly unknown[]): string {
  const path = join(root, `${name}.jsonl`)
  copyFileSync(base, path)
  appendEntries(path, entries)
  expect(statSync(path).size).toBeGreaterThan(64 * 1024 * 1024)
  return path
}

describe('resumeProvider on transcripts over 64 MiB', () => {
  it('resolves the assistant model near the end', async () => {
    const path = transcript('near', [
      assistantEntry('a1', `u${BULK_MIB}`, 'near-provider'),
      { type: 'custom', id: 'c1', parentId: 'a1' },
    ])
    expect(await resumeProvider(path)).toBe('near-provider')
  })

  it('follows the parent walk back to a model at the start of the file', async () => {
    const path = transcript('far', [{ type: 'custom', id: 'c1', parentId: `u${BULK_MIB}` }])
    expect(await resumeProvider(path)).toBe('first-provider')
  })

  it('jumps to an older branch instead of taking the file’s last answer', async () => {
    const path = transcript('jump', [
      assistantEntry('a1', `u${BULK_MIB}`, 'abandoned-provider'),
      { type: 'custom', id: 'c1', parentId: 'u1' },
    ])
    expect(await resumeProvider(path)).toBe('first-provider')
  })
})

describe('prepareProviderAccount on a strict Host', () => {
  it('restores the provider of a large transcript instead of refusing the resume', async () => {
    const path = transcript('strict', [assistantEntry('a1', `u${BULK_MIB}`, 'pi-claude-cli')])
    const account = vi.fn(async () => ({ id: 'slot', env: {} }))
    const runtime = {
      defaultProvider: vi.fn(async () => 'native'),
      packages: vi.fn(async () => [
        { name: '@saccolabs/pi-claude-cli', version: '0.10.0', installed: true },
      ]),
      account,
      strictAccountSelection: true,
    }
    const options = { workspacePath: '/repo', sessionPath: path }
    expect(await prepareProviderAccount(options, false, runtime)).toMatchObject({ id: 'slot' })
    expect(account).toHaveBeenCalledExactlyOnceWith({ sessionPath: path })
    expect(runtime.defaultProvider).not.toHaveBeenCalled()
  })
})
