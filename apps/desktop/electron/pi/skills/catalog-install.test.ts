import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { catalogLibrary, type SkillCatalogLibrary } from '@shared/skillsCatalog'
import { installCatalogSkill } from './catalog-install'
import { readSkillFileEntry, SKILL_SIDECAR } from './bundle'
import { writeZipStore } from '../zip'

vi.mock('@shared/skillsCatalog', () => ({ catalogLibrary: vi.fn() }))
let root: string
let library: SkillCatalogLibrary
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-catalog-install-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', root)
  library = {
    id: 'reviewed',
    label: 'Reviewed',
    repo: 'owner/repo',
    sha: basename(root),
    subpath: 'skills',
    url: 'https://example.com',
    blurb: 'test',
    skills: [{ name: 'alpha', description: 'a' }],
  }
  vi.mocked(catalogLibrary).mockReset().mockReturnValue(library)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})
const options = { libraryId: 'reviewed', skillName: 'alpha' }
function zip(): Buffer {
  return writeZipStore([
    { path: 'repo-pin/skills/alpha/SKILL.md', data: Buffer.from('body') },
    { path: 'repo-pin/skills/alpha/assets/note', data: Buffer.from('note') },
    { path: 'repo-pin/skills/alpha-other/SKILL.md', data: Buffer.from('excluded') },
  ])
}

it('uses the default pinned fetch with a timeout and reuses the zipball for renamed installs', async () => {
  const fetch = vi.fn(async () => new Response(new Uint8Array(zip())))
  vi.stubGlobal('fetch', fetch)
  const { dir, fileCount } = await installCatalogSkill({ ...options, targetName: 'renamed' })
  expect(fetch).toHaveBeenCalledWith(
    `https://codeload.github.com/${library.repo}/zip/${library.sha}`,
    {
      signal: expect.any(AbortSignal),
      redirect: 'follow',
    },
  )
  expect(fileCount).toBe(2)
  expect((await readSkillFileEntry(dir, 'assets/note')).content).toBe('note')
  expect(JSON.parse(await readFile(join(dir, SKILL_SIDECAR), 'utf8'))).toMatchObject({
    catalogId: 'reviewed',
    repo: library.repo,
    sha: library.sha,
    subpath: 'skills/alpha',
  })
  await installCatalogSkill(options)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('evicts failed default downloads and retries the same pin', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(new Uint8Array(zip())))
  vi.stubGlobal('fetch', fetch)
  await expect(installCatalogSkill(options)).rejects.toThrow('download failed (503)')
  expect(existsSync(join(root, 'skills'))).toBe(false)
  await installCatalogSkill(options)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('fetches manifest files instead of a warm zipball and enforces the default per-file stream cap', async () => {
  await installCatalogSkill({ ...options, fetchZip: async () => zip() })
  library.skills[0]!.files = ['SKILL.md']
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('manifest body'))
    .mockResolvedValueOnce(new Response(new Uint8Array(2 * 1024 * 1024 + 1)))
  vi.stubGlobal('fetch', fetch)
  const installed = await installCatalogSkill({ ...options, targetName: 'manifest' })
  expect(fetch).toHaveBeenCalledWith(
    `https://raw.githubusercontent.com/${library.repo}/${library.sha}/skills/alpha/SKILL.md`,
    expect.any(Object),
  )
  expect((await readSkillFileEntry(installed.dir, 'SKILL.md')).content).toBe('manifest body')
  await expect(installCatalogSkill({ ...options, targetName: 'too-large' })).rejects.toThrow(
    'download exceeds the size cap',
  )
  expect(existsSync(join(root, 'skills', 'too-large'))).toBe(false)
})

it('caps default archive downloads at 60 MiB before parsing or writing', async () => {
  let chunks = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (chunks++ < 61) controller.enqueue(new Uint8Array(1024 * 1024))
              else controller.close()
            },
          }),
        ),
    ),
  )
  await expect(installCatalogSkill(options)).rejects.toThrow('download exceeds the size cap')
  expect(existsSync(join(root, 'skills'))).toBe(false)
})

it('validates library, skill and target names before any download', async () => {
  const fetchZip = vi.fn(async () => zip())
  vi.mocked(catalogLibrary).mockReturnValueOnce(undefined)
  await expect(installCatalogSkill({ ...options, fetchZip })).rejects.toThrow(
    'unknown skill library',
  )
  await expect(installCatalogSkill({ ...options, skillName: 'missing', fetchZip })).rejects.toThrow(
    'not in Reviewed',
  )
  await expect(
    installCatalogSkill({ ...options, targetName: '../escape', fetchZip }),
  ).rejects.toThrow('lowercase')
  expect(fetchZip).not.toHaveBeenCalled()
})
