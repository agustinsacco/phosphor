/** Pinned catalog downloads and installation into the user skill root. */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { validateSkillName, type SkillProvenance } from '@shared/skills'
import {
  catalogLibrary,
  type SkillCatalogLibrary,
  type SkillCatalogSkill,
} from '@shared/skillsCatalog'
import { invalidZipEntryName, readZipEntries, writeZipStore, type ZipEntry } from '../zip'
import {
  MAX_ARCHIVE_BYTES,
  MAX_BUNDLE_FILES,
  MAX_TEXT_FILE_BYTES,
  registerKnownSkillDir,
  SKILL_SIDECAR,
  skillRoots,
  within,
} from './bundle'

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
  const { library, targetName, bundle } = await resolveCatalogBundle(options)
  const dir = await writeBundle(bundle, targetName, options.overwrite)
  await writeProvenance(dir, library, options.skillName)
  registerKnownSkillDir(dir)
  return { dir, fileCount: bundle.length }
}

type BundleFile = { rel: string; data: Buffer }

async function resolveCatalogBundle(options: InstallSkillOptions): Promise<{
  library: SkillCatalogLibrary
  targetName: string
  bundle: BundleFile[]
}> {
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
  const entries = await loadManifestOrZip(library, skill, wanted, options)
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

  return { library, targetName, bundle }
}

async function loadManifestZip(
  library: SkillCatalogLibrary,
  skill: SkillCatalogSkill,
  wanted: string,
  options: InstallSkillOptions,
): Promise<Buffer | undefined> {
  if (!skill.files) return undefined
  if (skill.files.length > MAX_BUNDLE_FILES) throw new Error('too many skill files')
  const files: ZipEntry[] = []
  let size = 0
  for (const path of skill.files) {
    if (invalidZipEntryName(path)) throw new Error('invalid manifest path')
    const url = `https://raw.githubusercontent.com/${library.repo}/${library.sha}/${wanted}${path}`
    const data = await (options.fetchFile ?? ((url) => defaultFetchZip(url, MAX_TEXT_FILE_BYTES)))(
      url,
    )
    size += data.length
    if (data.length > MAX_TEXT_FILE_BYTES || size > MAX_ARCHIVE_BYTES)
      throw new Error('skill exceeds the size cap')
    files.push({ path: `repo/${wanted}${path}`, data })
  }
  return writeZipStore(files)
}

async function loadManifestOrZip(
  library: SkillCatalogLibrary,
  skill: SkillCatalogSkill,
  wanted: string,
  options: InstallSkillOptions,
): Promise<ZipEntry[]> {
  const manifestZip = await loadManifestZip(library, skill, wanted, options)
  const cacheKey = `${library.repo}@${library.sha}`
  let zipball = zipballCache.get(cacheKey)
  if (!zipball && !manifestZip) {
    const fetcher = options.fetchZip ?? defaultFetchZip
    zipball = fetcher(`https://codeload.github.com/${library.repo}/zip/${library.sha}`)
    zipballCache.set(cacheKey, zipball)
    zipball.catch(() => zipballCache.delete(cacheKey))
  }
  return readZipEntries(manifestZip ?? (await zipball!))
}

async function writeBundle(
  bundle: BundleFile[],
  targetName: string,
  overwrite?: boolean,
): Promise<string> {
  const root = skillRoots().userRoot
  const dir = join(root, targetName)
  if (existsSync(dir)) {
    if (!overwrite)
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
  return dir
}

async function writeProvenance(
  dir: string,
  library: SkillCatalogLibrary,
  skillName: string,
): Promise<void> {
  const provenance: SkillProvenance = {
    catalogId: library.id,
    repo: library.repo,
    sha: library.sha,
    subpath: `${library.subpath}/${skillName}`,
    installedAt: Date.now(),
  }
  await writeFile(join(dir, SKILL_SIDECAR), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8')
}
