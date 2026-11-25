import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resumeProvider } from './resume-provider'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phosphor-resume-provider-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
async function transcript(entries: unknown[], version = 3) {
  const path = join(root, 'session.jsonl')
  await writeFile(
    path,
    [{ type: 'session', id: 'owned', version }, ...entries]
      .map((value) => JSON.stringify(value))
      .join('\n'),
    { mode: 0o600 },
  )
  return path
}

it('follows the selected branch and an assistant model switch, without rewriting the file', async () => {
  const path = await transcript([
    { type: 'model_change', id: 'a', parentId: null, provider: 'pi-claude-cli', modelId: 'claude' },
    {
      type: 'message',
      id: 'b',
      parentId: 'a',
      message: { role: 'assistant', provider: 'native', model: 'm' },
    },
    { type: 'model_change', id: 'c', parentId: 'a', provider: 'pi-claude-cli', modelId: 'other' },
    { type: 'custom', id: 'd', parentId: 'b' },
  ])
  const before = await readFile(path, 'utf8')
  expect(await resumeProvider(path)).toBe('native')
  expect(await readFile(path, 'utf8')).toBe(before)
})

it('restores Claude from the last assistant even when machine defaults changed', async () => {
  const path = await transcript([
    { type: 'model_change', id: 'a', parentId: null, provider: 'native', modelId: 'm' },
    {
      type: 'message',
      id: 'b',
      parentId: 'a',
      message: { role: 'assistant', provider: 'pi-claude-cli', model: 'claude' },
    },
  ])
  expect(await resumeProvider(path)).toBe('pi-claude-cli')
})

it('uses pi migration semantics for old linear transcripts', async () => {
  const path = await transcript(
    [
      { type: 'model_change', provider: 'pi-claude-cli', modelId: 'claude' },
      { type: 'message', message: { role: 'user', content: 'hello' } },
    ],
    1,
  )
  expect(await resumeProvider(path)).toBe('pi-claude-cli')
})

it('allows a genuinely model-less session to use the machine default', async () => {
  expect(await resumeProvider(await transcript([]))).toBeUndefined()
})

it('refuses cycles and malformed files instead of guessing a billing provider', async () => {
  const path = await transcript([
    { type: 'custom', id: 'a', parentId: 'b' },
    { type: 'custom', id: 'b', parentId: 'a' },
  ])
  await expect(resumeProvider(path)).rejects.toThrow('Cannot verify')
  await expect(resumeProvider(path)).rejects.toMatchObject({ code: 'resume-provider-unverified' })
  await writeFile(path, '{ broken')
  await expect(resumeProvider(path)).rejects.toThrow('Cannot verify')
  await expect(resumeProvider(path)).rejects.toMatchObject({ code: 'resume-provider-unverified' })
})

it('refuses a session that changed while its provider was read', async () => {
  const path = await transcript([
    { type: 'model_change', id: 'a', parentId: null, provider: 'native', modelId: 'm' },
  ])
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof open>) => {
    const handle = await actual.open(...args)
    const stat = handle.stat.bind(handle)
    let calls = 0
    handle.stat = (async () => {
      const result = await stat()
      return ++calls > 1 ? Object.assign(result, { mtimeMs: result.mtimeMs + 1 }) : result
    }) as typeof handle.stat
    return handle
  })
  await expect(resumeProvider(path)).rejects.toMatchObject({
    message: 'The session changed while verifying its provider.',
    code: 'resume-provider-changed',
  })
})

it('refuses more than the 2 GiB transcript bound, and substituted symlinks', async () => {
  const path = await transcript([])
  const link = join(root, 'link.jsonl')
  await symlink(path, link)
  await expect(resumeProvider(link)).rejects.toThrow()
  await truncate(path, 2 * 1024 ** 3 + 1)
  await expect(resumeProvider(path)).rejects.toMatchObject({
    message: 'Cannot verify the resumed session provider.',
    code: 'transcript-too-large',
  })
})
