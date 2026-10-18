import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmSkillImport, previewSkillImport } from './archive-import'
import { readSkillFileEntry } from './bundle'
import { writeZipStore } from '../zip'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-archive-import-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
function zip(files: Record<string, string>): Buffer {
  return writeZipStore(
    Object.entries(files).map(([path, text]) => ({ path, data: Buffer.from(text) })),
  )
}

it('previews uppercase Markdown without writes and preserves its bytes when overriding the name', async () => {
  const sourcePath = join(root, 'source.MD')
  const text = '---\ndescription: no name\n---\nbody π\n'
  await writeFile(sourcePath, text)
  const preview = await previewSkillImport(sourcePath)
  expect(preview).toMatchObject({
    sourcePath,
    kind: 'md',
    name: null,
    description: 'no name',
    skillMd: text,
    files: [{ path: 'SKILL.md', size: Buffer.byteLength(text) }],
  })
  expect(preview.warnings.length).toBeGreaterThan(0)
  expect(existsSync(join(root, 'agent'))).toBe(false)
  const { dir } = await confirmSkillImport({ sourcePath, scope: 'user', overrideName: 'named' })
  expect((await readSkillFileEntry(dir, 'SKILL.md')).content).toBe(text)
})

it.each(['', 'wrapper/'])(
  'imports a %s zip layout into the project and refuses collisions',
  async (prefix) => {
    const sourcePath = join(root, 'source.SKILL')
    const text = '---\nname: bundle\ndescription: test\n---\nbody'
    await writeFile(
      sourcePath,
      zip({ [`${prefix}SKILL.md`]: text, [`${prefix}scripts/run`]: 'run' }),
    )
    const preview = await previewSkillImport(sourcePath)
    expect(preview.kind).toBe('zip')
    expect(preview.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/run'])
    const options = { sourcePath, scope: 'project' as const, workspacePath: root }
    const { dir } = await confirmSkillImport(options)
    expect(dir).toBe(join(root, '.pi', 'skills', 'bundle'))
    expect(await readFile(join(dir, 'scripts/run'), 'utf8')).toBe('run')
    expect((await readSkillFileEntry(dir, 'SKILL.md')).content).toBe(text)
    await expect(confirmSkillImport(options)).rejects.toThrow('already exists')
  },
)

it('re-previews changed Markdown when confirming and requires a workspace for project scope', async () => {
  const sourcePath = join(root, 'source.md')
  await writeFile(sourcePath, '---\nname: original\ndescription: d\n---\nold')
  expect((await previewSkillImport(sourcePath)).name).toBe('original')
  await writeFile(sourcePath, '---\nname: changed\ndescription: d\n---\nnew')
  await expect(confirmSkillImport({ sourcePath, scope: 'project' })).rejects.toThrow(
    'no workspace open',
  )
  const { dir } = await confirmSkillImport({ sourcePath, scope: 'user' })
  expect(dir).toBe(join(root, 'agent', 'skills', 'changed'))
  expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('new')
})

it('rejects unsupported files, missing SKILL.md, ambiguous roots and unsafe entry names without writes', async () => {
  await expect(previewSkillImport(join(root, 'unsupported.txt'))).rejects.toThrow(
    'expected a .md, .zip or .skill file',
  )
  const sourcePath = join(root, 'source.zip')
  const missingSkillCases: Record<string, string>[] = [
    { 'notes.txt': 'missing' },
    { 'one/SKILL.md': 'body', 'two/notes': 'ambiguous' },
  ]
  for (const files of missingSkillCases) {
    await writeFile(sourcePath, zip(files))
    await expect(previewSkillImport(sourcePath)).rejects.toThrow('the archive has no SKILL.md')
  }
  await writeFile(sourcePath, zip({ 'SKILL.md': 'body', '../escape': 'unsafe' }))
  await expect(
    confirmSkillImport({ sourcePath, scope: 'user', overrideName: 'safe' }),
  ).rejects.toThrow('path traversal')
  expect(existsSync(join(root, 'agent'))).toBe(false)
})

it('refuses archive bytes above 60 MiB before parsing', async () => {
  const sourcePath = join(root, 'large.zip')
  await writeFile(sourcePath, '')
  await truncate(sourcePath, 60 * 1024 * 1024 + 1)
  await expect(previewSkillImport(sourcePath)).rejects.toThrow('archive exceeds the size cap')
})
