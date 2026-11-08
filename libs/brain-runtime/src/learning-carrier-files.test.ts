import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import {
  purgeLearningRoot,
  readLearningControl,
  writeLearningControl,
} from './learning-carrier-files'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'learning-private-files-')))
  roots.push(root)
  await writeLearningControl(join(root, 'owner.json'), { jobId: 'job', nonce: 'nonce' })
  return root
}
const owner = (jobId = 'job') =>
  JSON.stringify({
    type: 'custom',
    customType: 'phosphor-brain-owner',
    data: { kind: 'brain', jobId },
  }) + '\n'
it('purges owned source/control copies after a killed writer leaves a torn tail or header-only control', async () => {
  const root = await fixture()
  await writeFile(join(root, 'source.jsonl'), owner() + '{torn tail')
  await mkdir(join(root, 'control'))
  await writeFile(join(root, 'control', 'control.jsonl'), '{"type":"session"}\n')
  await purgeLearningRoot(root, 'job', 'nonce')
  await expect(readFile(join(root, 'source.jsonl'))).rejects.toThrow()
})
it('refuses changed root/transcript ownership and substituted symlinks without touching their original targets', async () => {
  const root = await fixture(),
    victim = await fixture()
  const path = join(victim, 'untouched.txt')
  await writeFile(path, 'original')
  await expect(purgeLearningRoot(root, 'different', 'nonce')).rejects.toThrow('ownership')
  await writeFile(join(root, 'source.jsonl'), owner('other'))
  await expect(purgeLearningRoot(root, 'job', 'nonce')).rejects.toThrow('ownership')
  await rm(join(root, 'source.jsonl'))
  await symlink(path, join(root, 'source.jsonl'))
  await expect(purgeLearningRoot(root, 'job', 'nonce')).rejects.toThrow('substituted')
  expect(await readFile(path, 'utf8')).toBe('original')
})
it('caps private control files and refuses existing-file/symlink overwrite', async () => {
  const root = await fixture(),
    path = join(root, 'control.json')
  await expect(writeLearningControl(path, { text: 'x'.repeat(2_000_000) })).rejects.toThrow(
    'exceeds',
  )
  await writeLearningControl(path, { bounded: true })
  await expect(writeLearningControl(path, {})).rejects.toThrow()
  expect(await readLearningControl(path)).toEqual({ bounded: true })
  const oversize = join(root, 'oversize.json')
  await writeFile(oversize, 'x'.repeat(2_000_001))
  await expect(readLearningControl(oversize)).rejects.toThrow('oversized')
})
