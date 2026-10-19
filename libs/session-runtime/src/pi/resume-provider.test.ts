import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RESUME_PROVIDER_MAX_BYTES, resumeProvider } from './resume-provider'

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
  await writeFile(path, '{ broken')
  await expect(resumeProvider(path)).rejects.toThrow('Cannot verify')
})

it('bounds inspection and refuses substituted symlinks', async () => {
  const path = await transcript([])
  const link = join(root, 'link.jsonl')
  await symlink(path, link)
  await expect(resumeProvider(link)).rejects.toThrow()
  await truncate(path, RESUME_PROVIDER_MAX_BYTES + 1)
  await expect(resumeProvider(path)).rejects.toThrow('Cannot verify')
})
