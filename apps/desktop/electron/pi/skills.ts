/**
 * Skills page backend: what skills resolve, and every mutation on them.
 *
 * Resolution asks pi itself — a throwaway `pi --mode rpc --no-session`
 * answering `get_commands` (the model-catalogue machinery, no tokens spent).
 * pi's answer carries each skill's path, scope and source, so Phosphor never
 * re-implements the discovery chain (six roots, settings arrays, packages,
 * trust). When pi can't run, or answers with no skills at all (the
 * e2e stub does), a filesystem scan of the roots Phosphor knows about keeps the
 * page honest instead of empty — labelled `probe: 'scan'` so the UI can say
 * the list is approximate.
 *
 * Mutations only ever touch the two phosphor-writable roots
 * (`~/.pi/agent/skills`, `<ws>/.pi/skills`). Package dirs are npm-owned and
 * `pi update` would destroy edits; foreign harness dirs (`.claude/skills`)
 * are read-only here on purpose.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { invalidZipEntryName, readZipEntries, writeZipStore, type ZipEntry } from './zip'
import {
  composeSkillMd,
  parseSkillFrontmatter,
  skillFrontmatterWarnings,
  validateSkillName,
  type SkillImportPreview,
  type SkillProvenance,
  type SkillScope,
} from '@shared/skills'
import { catalogLibrary } from '@shared/skillsCatalog'
import {
  forgetKnownSkillDir,
  isWritableSkillDir,
  MAX_ARCHIVE_BYTES,
  MAX_BUNDLE_FILES,
  MAX_TEXT_FILE_BYTES,
  registerKnownSkillDir,
  requireKnownPath,
  requireKnownSkillDir,
  SKILL_SIDECAR,
  skillRoots,
  within,
} from './skills/bundle'

export { resolveSkills, type SkillProbeOptions } from './skills/discovery'
export {
  buildSkillZip,
  LEGACY_SKILL_SIDECAR,
  readSkillFileEntry,
  SKILL_SIDECAR,
  skillRoots,
  registerKnownSkillDir as _registerKnownSkillDirForTest,
} from './skills/bundle'

export interface CreateSkillOptions {
  scope: SkillScope
  workspacePath?: string
  name: string
  description: string
  content: string
  draft: boolean
}

export async function createSkill(options: CreateSkillOptions): Promise<{ dir: string }> {
  const nameError = validateSkillName(options.name)
  if (nameError) throw new Error(nameError)
  const roots = skillRoots(options.workspacePath)
  const root = options.scope === 'project' ? roots.projectRoot : roots.userRoot
  if (!root) throw new Error('no workspace open for a project skill')
  const dir = join(root, options.name)
  if (existsSync(dir)) throw new Error(`a skill named "${options.name}" already exists there`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), composeSkillMd(options), 'utf8')
  registerKnownSkillDir(dir)
  return { dir }
}

export async function writeSkillFileEntry(
  dir: string,
  rel: string,
  content: string,
  workspacePath?: string,
): Promise<void> {
  if (!isWritableSkillDir(dir, workspacePath))
    throw new Error('this skill is read-only in Phosphor')
  const target = requireKnownPath(dir, rel)
  if (basename(target) === SKILL_SIDECAR) throw new Error('the provenance sidecar is not editable')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}

export async function deleteSkill(dir: string, workspacePath?: string): Promise<void> {
  const base = requireKnownSkillDir(dir)
  if (!isWritableSkillDir(base, workspacePath))
    throw new Error('this skill is read-only in Phosphor')
  await shell.trashItem(base)
  forgetKnownSkillDir(base)
}

// ---------------------------------------------------------------------------
// Catalog installs

type ZipFetcher = (url: string) => Promise<Buffer>

const zipballCache = new Map<string, Promise<Buffer>>()

async function defaultFetchZip(url: string, limit = MAX_ARCHIVE_BYTES): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) throw new Error('download exceeds the size cap')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export interface InstallSkillOptions {
  libraryId: string
  skillName: string
  /** Install under a different directory name (collision escape hatch). */
  targetName?: string
  /** Reinstall over an existing phosphor-installed copy (the update flow). */
  overwrite?: boolean
  fetchZip?: ZipFetcher
  fetchFile?: ZipFetcher
}

/**
 * Install one skill from a pinned catalog library into the user root.
 * Fetches the repo zipball at the pinned SHA (cached per repo@sha, so adding
 * three skills from one library downloads once) and extracts only entries
 * under the skill's subpath, through the guarded zip reader. Large libraries
 * may instead supply a reviewed file manifest; every file is fetched at the
 * same pin and the assembled bundle passes the same zip guards.
 */
export async function installCatalogSkill(
  options: InstallSkillOptions,
): Promise<{ dir: string; fileCount: number }> {
  const library = catalogLibrary(options.libraryId)
  if (!library) throw new Error(`unknown skill library: ${options.libraryId}`)
  const skill = library.skills.find((skill) => skill.name === options.skillName)
  if (!skill) {
    throw new Error(`"${options.skillName}" is not in ${library.label}`)
  }
  const targetName = options.targetName ?? options.skillName
  const nameError = validateSkillName(targetName)
  if (nameError) throw new Error(nameError)

  const wanted = `${library.subpath}/${options.skillName}/`
  let manifestZip: Buffer | undefined
  if (skill.files) {
    if (skill.files.length > MAX_BUNDLE_FILES) throw new Error('too many skill files')
    const files: ZipEntry[] = []
    let size = 0
    for (const path of skill.files) {
      if (invalidZipEntryName(path)) throw new Error('invalid manifest path')
      const url = `https://raw.githubusercontent.com/${library.repo}/${library.sha}/${wanted}${path}`
      const data = await (
        options.fetchFile ?? ((url) => defaultFetchZip(url, MAX_TEXT_FILE_BYTES))
      )(url)
      size += data.length
      if (data.length > MAX_TEXT_FILE_BYTES || size > MAX_ARCHIVE_BYTES)
        throw new Error('skill exceeds the size cap')
      files.push({ path: `repo/${wanted}${path}`, data })
    }
    manifestZip = writeZipStore(files)
  }
  const cacheKey = `${library.repo}@${library.sha}`
  let zipball = zipballCache.get(cacheKey)
  if (!zipball && !manifestZip) {
    const fetcher = options.fetchZip ?? defaultFetchZip
    zipball = fetcher(`https://codeload.github.com/${library.repo}/zip/${library.sha}`)
    zipballCache.set(cacheKey, zipball)
    zipball.catch(() => zipballCache.delete(cacheKey))
  }
  const entries = readZipEntries(manifestZip ?? (await zipball!))

  // Zipball paths start with a `<repo>-<sha>/` segment; match on what follows.
  const bundle: Array<{ rel: string; data: Buffer }> = []
  for (const entry of entries) {
    const slash = entry.path.indexOf('/')
    if (slash === -1) continue
    const inner = entry.path.slice(slash + 1)
    if (inner.startsWith(wanted) && inner.length > wanted.length) {
      bundle.push({ rel: inner.slice(wanted.length), data: entry.data })
    }
  }
  if (!bundle.some((file) => file.rel === 'SKILL.md')) {
    throw new Error(
      `${options.skillName} has no SKILL.md at ${wanted} in ${library.repo}@${library.sha.slice(0, 7)}`,
    )
  }

  const root = skillRoots().userRoot
  const dir = join(root, targetName)
  if (existsSync(dir)) {
    if (!options.overwrite)
      throw new Error(
        `a skill named "${targetName}" already exists — remove it or install under another name`,
      )
    await rm(dir, { recursive: true, force: true })
  }
  for (const file of bundle) {
    const target = resolve(dir, file.rel)
    if (!within(dir, target)) throw new Error(`entry escapes the bundle: ${file.rel}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.data)
  }
  const provenance: SkillProvenance = {
    catalogId: library.id,
    repo: library.repo,
    sha: library.sha,
    subpath: `${library.subpath}/${options.skillName}`,
    installedAt: Date.now(),
  }
  await writeFile(join(dir, SKILL_SIDECAR), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
  registerKnownSkillDir(dir)
  return { dir, fileCount: bundle.length }
}

// ---------------------------------------------------------------------------
// Imports (upload)

/** Inspect a user-chosen `.md` / `.zip` / `.skill` without writing anything. */
export async function previewSkillImport(sourcePath: string): Promise<SkillImportPreview> {
  if (/\.md$/i.test(sourcePath)) {
    const text = await readFile(sourcePath, 'utf8')
    const { attrs } = parseSkillFrontmatter(text)
    const warnings = skillFrontmatterWarnings(attrs)
    return {
      sourcePath,
      kind: 'md',
      name: attrs['name'] || null,
      description: attrs['description'] || null,
      files: [{ path: 'SKILL.md', size: Buffer.byteLength(text) }],
      skillMd: text,
      warnings,
    }
  }
  if (!/\.(zip|skill)$/i.test(sourcePath)) throw new Error('expected a .md, .zip or .skill file')
  const info = await stat(sourcePath)
  if (info.size > MAX_ARCHIVE_BYTES) throw new Error('archive exceeds the size cap')
  const bundle = archiveBundle(readZipEntries(await readFile(sourcePath)))
  const skillMd = bundle.find((file) => file.rel === 'SKILL.md')
  if (!skillMd) throw new Error('the archive has no SKILL.md')
  const text = skillMd.data.toString('utf8')
  const { attrs } = parseSkillFrontmatter(text)
  return {
    sourcePath,
    kind: 'zip',
    name: attrs['name'] || null,
    description: attrs['description'] || null,
    files: bundle.map((file) => ({ path: file.rel, size: file.data.length })),
    skillMd: text,
    warnings: skillFrontmatterWarnings(attrs),
  }
}

/**
 * Normalize archive entries to bundle-relative paths: SKILL.md may sit at the
 * archive root or inside a single top-level folder (how exports and GitHub
 * "download zip" both package it).
 */
function archiveBundle(entries: ZipEntry[]): Array<{ rel: string; data: Buffer }> {
  if (entries.some((entry) => entry.path === 'SKILL.md')) {
    return entries.map((entry) => ({ rel: entry.path, data: entry.data }))
  }
  const tops = new Set(entries.map((entry) => entry.path.split('/')[0]))
  if (tops.size === 1) {
    const prefix = `${[...tops][0]}/`
    return entries
      .filter((entry) => entry.path.length > prefix.length)
      .map((entry) => ({ rel: entry.path.slice(prefix.length), data: entry.data }))
  }
  return entries.map((entry) => ({ rel: entry.path, data: entry.data }))
}

export interface ConfirmImportOptions {
  sourcePath: string
  scope: SkillScope
  workspacePath?: string
  /** Overrides the frontmatter name (required when it is missing/invalid). */
  overrideName?: string
}

export async function confirmSkillImport(options: ConfirmImportOptions): Promise<{ dir: string }> {
  const preview = await previewSkillImport(options.sourcePath)
  const name = options.overrideName ?? preview.name ?? ''
  const nameError = validateSkillName(name)
  if (nameError) throw new Error(nameError)
  const roots = skillRoots(options.workspacePath)
  const root = options.scope === 'project' ? roots.projectRoot : roots.userRoot
  if (!root) throw new Error('no workspace open for a project skill')
  const dir = join(root, name)
  if (existsSync(dir)) throw new Error(`a skill named "${name}" already exists there`)

  if (preview.kind === 'md') {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), preview.skillMd, 'utf8')
  } else {
    const bundle = archiveBundle(readZipEntries(await readFile(options.sourcePath)))
    for (const file of bundle) {
      const target = resolve(dir, file.rel)
      if (!within(dir, target)) throw new Error(`entry escapes the bundle: ${file.rel}`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.data)
    }
  }
  registerKnownSkillDir(dir)
  return { dir }
}
