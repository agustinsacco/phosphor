import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSkillZip,
  confirmSkillImport,
  createSkill,
  deleteSkill,
  installCatalogSkill,
  previewSkillImport,
  readSkillFileEntry,
  resolveSkills,
  writeSkillFileEntry,
  _registerKnownSkillDirForTest,
  SKILL_SIDECAR,
  LEGACY_SKILL_SIDECAR,
} from './skills'
import { readZipEntries, writeZipStore } from './zip'
import { SKILL_CATALOG } from '@shared/skillsCatalog'

/**
 * All filesystem behaviour, driven through `PI_CODING_AGENT_DIR` like
 * `packages.test.ts`. The RPC probe path is deliberately not exercised here
 * (no binaryPath ⇒ scan fallback) — the probe's plumbing is the same
 * PiRpcClient every session uses, and e2e covers the spawn contract.
 */
let agentDir: string
let workspace: string

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'phosphor-skills-agent-'))
  workspace = mkdtempSync(join(tmpdir(), 'phosphor-skills-ws-'))
  process.env.PI_CODING_AGENT_DIR = agentDir
})

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR
  rmSync(agentDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

function seedSkill(root: string, name: string, extraAttrs = ''): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n${extraAttrs}---\n\n# ${name}\n`,
  )
  return dir
}

describe('resolveSkills (scan fallback)', () => {
  it('finds user-root, project-root and settings-listed skills', async () => {
    seedSkill(join(agentDir, 'skills'), 'alpha')
    seedSkill(join(workspace, '.pi', 'skills'), 'bravo')
    const foreign = mkdtempSync(join(tmpdir(), 'phosphor-skills-foreign-'))
    seedSkill(foreign, 'charlie')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ skills: [foreign] }))

    const result = await resolveSkills({ workspacePath: workspace })
    expect(result.probe).toBe('scan')
    const byName = new Map(result.skills.map((skill) => [skill.name, skill]))
    expect(byName.get('alpha')?.scope).toBe('user')
    expect(byName.get('alpha')?.writable).toBe(true)
    expect(byName.get('bravo')?.scope).toBe('project')
    expect(byName.get('bravo')?.writable).toBe(true)
    expect(byName.get('charlie')?.writable).toBe(false)
    rmSync(foreign, { recursive: true, force: true })
  })

  it('reports draft state, warnings and bundle files', async () => {
    const dir = seedSkill(join(agentDir, 'skills'), 'delta', 'disable-model-invocation: true\n')
    mkdirSync(join(dir, 'references'))
    writeFileSync(join(dir, 'references', 'notes.md'), 'notes')
    writeFileSync(join(dir, SKILL_SIDECAR), JSON.stringify({ catalogId: 'x', repo: 'r', sha: 's' }))

    const result = await resolveSkills({})
    const delta = result.skills.find((skill) => skill.name === 'delta')!
    expect(delta.draft).toBe(true)
    expect(delta.files.map((file) => file.path)).toEqual(['SKILL.md', 'references/notes.md'])
    expect(delta.provenance?.repo).toBe('r')
  })

  it('still reads the pre-rename (pidex) provenance sidecar and hides it from the bundle', async () => {
    const dir = seedSkill(join(agentDir, 'skills'), 'echo', '')
    writeFileSync(
      join(dir, LEGACY_SKILL_SIDECAR),
      JSON.stringify({ catalogId: 'x', repo: 'legacy-repo', sha: 's' }),
    )

    const result = await resolveSkills({})
    const echo = result.skills.find((skill) => skill.name === 'echo')!
    expect(echo.provenance?.repo).toBe('legacy-repo')
    expect(echo.files.map((file) => file.path)).toEqual(['SKILL.md'])
  })
})

describe('read/write containment', () => {
  it('refuses paths outside a known skill dir', async () => {
    const dir = seedSkill(join(agentDir, 'skills'), 'echo')
    await resolveSkills({})
    await expect(readSkillFileEntry(dir, '../../settings.json')).rejects.toThrow(/escapes/)
    await expect(readSkillFileEntry(join(tmpdir(), 'nope'), 'SKILL.md')).rejects.toThrow(/unknown/)
    const read = await readSkillFileEntry(dir, 'SKILL.md')
    expect(read.content).toContain('name: echo')
  })

  it('writes only into writable roots and never the sidecar', async () => {
    const dir = seedSkill(join(agentDir, 'skills'), 'foxtrot')
    const foreign = mkdtempSync(join(tmpdir(), 'phosphor-skills-foreign-'))
    const foreignDir = seedSkill(foreign, 'golf')
    _registerKnownSkillDirForTest(foreignDir)
    await resolveSkills({})
    _registerKnownSkillDirForTest(foreignDir)

    await writeSkillFileEntry(dir, 'SKILL.md', 'updated')
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('updated')
    await expect(writeSkillFileEntry(foreignDir, 'SKILL.md', 'x')).rejects.toThrow(/read-only/)
    await expect(writeSkillFileEntry(dir, SKILL_SIDECAR, 'x')).rejects.toThrow(/sidecar/)
    rmSync(foreign, { recursive: true, force: true })
  })
})

describe('create / delete', () => {
  it('creates a valid bundle and refuses collisions and bad names', async () => {
    const { dir } = await createSkill({
      scope: 'user',
      name: 'hotel-skill',
      description: 'Does hotel things',
      content: '# Hotel',
      draft: true,
    })
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('disable-model-invocation: true')
    await expect(
      createSkill({
        scope: 'user',
        name: 'hotel-skill',
        description: 'd',
        content: '',
        draft: false,
      }),
    ).rejects.toThrow(/already exists/)
    await expect(
      createSkill({ scope: 'user', name: 'Bad Name', description: 'd', content: '', draft: false }),
    ).rejects.toThrow(/lowercase/)
  })

  it('deletes only known writable dirs', async () => {
    const dir = seedSkill(join(agentDir, 'skills'), 'india')
    await resolveSkills({})
    await deleteSkill(dir)
    expect(existsSync(dir)).toBe(false)
    await expect(deleteSkill(join(tmpdir(), 'never-seen'))).rejects.toThrow(/unknown/)
  })
})

describe('export', () => {
  it('zips the bundle without the provenance sidecar', async () => {
    const dir = seedSkill(join(agentDir, 'skills'), 'juliet')
    writeFileSync(join(dir, SKILL_SIDECAR), '{}')
    await resolveSkills({})
    const { fileName, data } = await buildSkillZip(dir)
    expect(fileName).toBe('juliet.zip')
    const paths = readZipEntries(data).map((entry) => entry.path)
    expect(paths).toEqual(['juliet/SKILL.md'])
  })
})

describe('installCatalogSkill', () => {
  it('extracts one skill from a pinned zipball and writes provenance', async () => {
    const library = SKILL_CATALOG[0]!
    const skillName = library.skills[0]!.name
    const zipball = writeZipStore([
      {
        path: `repo-${library.sha}/${library.subpath}/${skillName}/SKILL.md`,
        data: Buffer.from(`---\nname: ${skillName}\ndescription: d\n---\nbody`),
      },
      {
        path: `repo-${library.sha}/${library.subpath}/${skillName}/LICENSE.txt`,
        data: Buffer.from('MIT'),
      },
      {
        path: `repo-${library.sha}/${library.subpath}/other-skill/SKILL.md`,
        data: Buffer.from('not wanted'),
      },
    ])
    const fetched: string[] = []
    const fetchZip = (url: string): Promise<Buffer> => {
      fetched.push(url)
      return Promise.resolve(zipball)
    }

    const { dir, fileCount } = await installCatalogSkill({
      libraryId: library.id,
      skillName,
      fetchZip,
    })
    expect(fetched[0]).toBe(`https://codeload.github.com/${library.repo}/zip/${library.sha}`)
    expect(fileCount).toBe(2)
    expect(existsSync(join(dir, 'LICENSE.txt'))).toBe(true)
    expect(existsSync(join(agentDir, 'skills', skillName, 'SKILL.md'))).toBe(true)
    const sidecar = JSON.parse(readFileSync(join(dir, SKILL_SIDECAR), 'utf8'))
    expect(sidecar.sha).toBe(library.sha)

    // Second install without overwrite refuses; with overwrite reinstalls.
    await expect(
      installCatalogSkill({ libraryId: library.id, skillName, fetchZip }),
    ).rejects.toThrow(/already exists/)
    await installCatalogSkill({ libraryId: library.id, skillName, overwrite: true, fetchZip })
  })

  it('refuses unknown libraries and unknown skills', async () => {
    await expect(
      installCatalogSkill({
        libraryId: 'nope',
        skillName: 'x',
        fetchZip: () => Promise.resolve(Buffer.alloc(0)),
      }),
    ).rejects.toThrow(/unknown skill library/)
    await expect(
      installCatalogSkill({
        libraryId: SKILL_CATALOG[0]!.id,
        skillName: 'not-a-real-skill',
        fetchZip: () => Promise.resolve(Buffer.alloc(0)),
      }),
    ).rejects.toThrow(/not in/)
  })
})

describe('import', () => {
  it('previews and installs a bare .md', async () => {
    const source = join(workspace, 'my-skill.md')
    writeFileSync(source, '---\nname: kilo\ndescription: k\n---\n# K')
    const preview = await previewSkillImport(source)
    expect(preview.kind).toBe('md')
    expect(preview.name).toBe('kilo')
    const { dir } = await confirmSkillImport({ sourcePath: source, scope: 'user' })
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('name: kilo')
  })

  it('previews a zip, unwraps a single top folder, and installs to project scope', async () => {
    const source = join(workspace, 'bundle.skill')
    const zip = writeZipStore([
      { path: 'lima/SKILL.md', data: Buffer.from('---\nname: lima\ndescription: l\n---\nbody') },
      { path: 'lima/scripts/run.sh', data: Buffer.from('#!/bin/sh\n') },
    ])
    writeFileSync(source, zip)
    const preview = await previewSkillImport(source)
    expect(preview.files.map((file) => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
    const { dir } = await confirmSkillImport({
      sourcePath: source,
      scope: 'project',
      workspacePath: workspace,
    })
    expect(dir).toBe(join(workspace, '.pi', 'skills', 'lima'))
    expect(existsSync(join(dir, 'scripts', 'run.sh'))).toBe(true)
  })

  it('requires a name from frontmatter or the override', async () => {
    const source = join(workspace, 'anon.md')
    writeFileSync(source, '---\ndescription: no name\n---\nbody')
    const preview = await previewSkillImport(source)
    expect(preview.name).toBeNull()
    await expect(confirmSkillImport({ sourcePath: source, scope: 'user' })).rejects.toThrow(
      /required/,
    )
    const { dir } = await confirmSkillImport({
      sourcePath: source,
      scope: 'user',
      overrideName: 'named-now',
    })
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true)
  })
})
