import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { catalogLibrary, type SkillCatalogLibrary } from '@shared/skillsCatalog'
import {
  confirmSkillImport,
  installCatalogSkill,
  previewSkillImport,
  readSkillFileEntry,
  SKILL_SIDECAR,
} from './skills'
import { writeZipStore } from './zip'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
vi.mock('@shared/skillsCatalog', () => ({ catalogLibrary: vi.fn() }))
let root: string
let library: SkillCatalogLibrary
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-install-characterization-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', root)
  library = {
    id: 'reviewed',
    label: 'Reviewed library',
    repo: 'owner/repo',
    sha: basename(root),
    subpath: 'skills',
    url: 'https://example.com',
    blurb: 'test',
    skills: [
      { name: 'alpha', description: 'a' },
      { name: 'bravo', description: 'b' },
    ],
  }
  vi.mocked(catalogLibrary).mockReset().mockReturnValue(library)
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
function repoZip(): Buffer {
  return zip({
    'repo-pin/skills/alpha/SKILL.md': 'alpha body',
    'repo-pin/skills/alpha/assets/note.txt': 'asset',
    'repo-pin/skills/bravo/SKILL.md': 'bravo body',
    'repo-pin/skills/alpha-other/SKILL.md': 'not alpha',
    'repo-pin/elsewhere/alpha/SKILL.md': 'wrong subpath',
  })
}
const options = { libraryId: 'reviewed', skillName: 'alpha' }

it('fetches the pinned repo once, selects only the requested subpath and registers provenance', async () => {
  const fetchZip = vi.fn(async () => repoZip())
  const before = Date.now()
  const installed = await installCatalogSkill({ ...options, fetchZip })
  await installCatalogSkill({ ...options, skillName: 'bravo', fetchZip })
  expect(fetchZip).toHaveBeenCalledExactlyOnceWith(
    `https://codeload.github.com/${library.repo}/zip/${library.sha}`,
  )
  expect(installed).toEqual({ dir: join(root, 'skills', 'alpha'), fileCount: 2 })
  expect((await readSkillFileEntry(installed.dir, 'assets/note.txt')).content).toBe('asset')
  const provenance = JSON.parse(await readFile(join(installed.dir, SKILL_SIDECAR), 'utf8'))
  expect(provenance).toEqual({
    catalogId: library.id,
    repo: library.repo,
    sha: library.sha,
    subpath: 'skills/alpha',
    installedAt: expect.any(Number),
  })
  expect(provenance.installedAt).toBeGreaterThanOrEqual(before)
  expect(provenance.installedAt).toBeLessThanOrEqual(Date.now())
})

it('evicts a failed cached download so the same pin can be retried', async () => {
  const fetchZip = vi
    .fn<NonNullable<Parameters<typeof installCatalogSkill>[0]['fetchZip']>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(repoZip())
  await expect(installCatalogSkill({ ...options, fetchZip })).rejects.toThrow('offline')
  expect(existsSync(join(root, 'skills', 'alpha'))).toBe(false)
  await installCatalogSkill({ ...options, fetchZip })
  expect(fetchZip).toHaveBeenCalledTimes(2)
})

it('fetches reviewed manifest paths at the pin without fetching the zipball', async () => {
  library.skills[0]!.files = ['SKILL.md', 'assets/note.txt']
  const fetchFile = vi.fn<(url: string) => Promise<Buffer>>(async () => Buffer.from('reviewed'))
  const fetchZip = vi.fn(async () => {
    throw new Error('unexpected zip fetch')
  })
  const result = await installCatalogSkill({ ...options, fetchFile, fetchZip })
  expect(result.fileCount).toBe(2)
  expect(fetchFile.mock.calls.map((call) => call[0])).toEqual([
    `https://raw.githubusercontent.com/${library.repo}/${library.sha}/skills/alpha/SKILL.md`,
    `https://raw.githubusercontent.com/${library.repo}/${library.sha}/skills/alpha/assets/note.txt`,
  ])
  expect(fetchZip).not.toHaveBeenCalled()
})

it.each([
  { files: ['../SKILL.md'], error: 'invalid manifest path' },
  { files: Array.from({ length: 501 }, () => 'SKILL.md'), error: 'too many skill files' },
])('rejects manifest $error before fetching or writing', async ({ files, error }) => {
  library.skills[0]!.files = files
  const fetchFile = vi.fn(async () => Buffer.from('body'))
  await expect(installCatalogSkill({ ...options, fetchFile })).rejects.toThrow(error)
  expect(fetchFile).not.toHaveBeenCalled()
  expect(existsSync(join(root, 'skills'))).toBe(false)
})

it('rejects manifest files above 2 MiB and assembled downloads above 60 MiB without writes', async () => {
  library.skills[0]!.files = ['SKILL.md']
  await expect(
    installCatalogSkill({ ...options, fetchFile: async () => Buffer.alloc(2 * 1024 * 1024 + 1) }),
  ).rejects.toThrow('skill exceeds the size cap')
  library.skills[0]!.files = Array.from({ length: 31 }, (_, index) => `${index}.md`)
  await expect(
    installCatalogSkill({ ...options, fetchFile: async () => Buffer.alloc(2 * 1024 * 1024) }),
  ).rejects.toThrow('skill exceeds the size cap')
  expect(existsSync(join(root, 'skills'))).toBe(false)
})

it('validates SKILL.md before overwrite and refuses collisions before cleanup, then removes obsolete files', async () => {
  const dir = join(root, 'skills', 'alpha')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'obsolete.txt'), 'keep until validated')
  library.skills[0]!.files = ['notes.md']
  const fetchFile = async () => Buffer.from('body')
  await expect(installCatalogSkill({ ...options, overwrite: true, fetchFile })).rejects.toThrow(
    'alpha has no SKILL.md at skills/alpha/',
  )
  expect(await readFile(join(dir, 'obsolete.txt'), 'utf8')).toBe('keep until validated')
  library.skills[0]!.files = ['SKILL.md']
  await expect(installCatalogSkill({ ...options, fetchFile })).rejects.toThrow('already exists')
  expect(existsSync(join(dir, 'obsolete.txt'))).toBe(true)
  await installCatalogSkill({ ...options, overwrite: true, fetchFile })
  expect(existsSync(join(dir, 'obsolete.txt'))).toBe(false)
  expect((await readSkillFileEntry(dir, 'SKILL.md')).content).toBe('body')
})

it('unwraps exactly one archive root, re-reads the source on confirm and refuses destination collisions', async () => {
  const sourcePath = join(root, 'bundle.skill')
  await writeFile(
    sourcePath,
    zip({ 'outer/SKILL.md': '---\nname: before\ndescription: d\n---\nold' }),
  )
  expect((await previewSkillImport(sourcePath)).files).toEqual([{ path: 'SKILL.md', size: 39 }])
  await writeFile(
    sourcePath,
    zip({
      'outer/SKILL.md': '---\nname: after\ndescription: d\n---\nnew',
      'outer/assets/a': 'asset',
    }),
  )
  const { dir } = await confirmSkillImport({ sourcePath, scope: 'project', workspacePath: root })
  expect(dir).toBe(join(root, '.pi', 'skills', 'after'))
  expect((await readSkillFileEntry(dir, 'SKILL.md')).content).toContain('new')
  expect(await readFile(join(dir, 'assets', 'a'), 'utf8')).toBe('asset')
  await expect(
    confirmSkillImport({ sourcePath, scope: 'project', workspacePath: root }),
  ).rejects.toThrow('already exists')
})

it('accepts root SKILL.md but refuses missing or multiple-root archives', async () => {
  const source = join(root, 'bundle.zip')
  await writeFile(
    source,
    zip({ 'SKILL.md': '---\nname: direct\ndescription: d\n---\nbody', 'other/note': 'ok' }),
  )
  expect((await previewSkillImport(source)).files.map((file) => file.path)).toEqual([
    'SKILL.md',
    'other/note',
  ])
  await writeFile(source, zip({ 'one/SKILL.md': 'body', 'two/note': 'another root' }))
  await expect(previewSkillImport(source)).rejects.toThrow('the archive has no SKILL.md')
  await writeFile(source, zip({ 'one/note': 'no skill' }))
  await expect(confirmSkillImport({ sourcePath: source, scope: 'user' })).rejects.toThrow(
    'the archive has no SKILL.md',
  )
})
