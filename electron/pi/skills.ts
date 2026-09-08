/**
 * Skills page backend: what skills resolve, and every mutation on them.
 *
 * Resolution asks pi itself — a throwaway `pi --mode rpc --no-session`
 * answering `get_commands` (the connector-auth/model-catalogue machinery, no
 * tokens spent). pi's answer carries each skill's path, scope and source, so
 * Phosphor never re-implements the discovery chain (six roots, settings arrays,
 * packages, trust). When pi can't run, or answers with no skills at all (the
 * e2e stub does), a filesystem scan of the roots Phosphor knows about keeps the
 * page honest instead of empty — labelled `probe: 'scan'` so the UI can say
 * the list is approximate.
 *
 * Mutations only ever touch the two phosphor-writable roots
 * (`~/.pi/agent/skills`, `<ws>/.pi/skills`). Package dirs are npm-owned and
 * `pi update` would destroy edits; foreign harness dirs (`.claude/skills`)
 * are read-only here on purpose.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PiRpcClient } from './rpc-client'
import { piAgentDir } from './pi-paths'
import { readZipEntries, writeZipStore, type ZipEntry } from './zip'
import type { RpcResponse, RpcResponseDataMap } from '@shared/rpc'
import {
  composeSkillMd,
  isSkillDraft,
  parseSkillFrontmatter,
  skillFrontmatterWarnings,
  validateSkillName,
  type ResolvedSkill,
  type SkillFileEntry,
  type SkillImportPreview,
  type SkillProvenance,
  type SkillScope,
  type SkillsListResult,
} from '@shared/skills'
import { catalogLibrary } from '@shared/skillsCatalog'

/** Provenance sidecar name. Dot-prefixed: skill discovery ignores dotfiles. */
export const SKILL_SIDECAR = '.phosphor-skill.json'
/** Sidecar name written by pre-rename (pidex) installs; still read, never written. */
export const LEGACY_SKILL_SIDECAR = '.pidex-skill.json'

const RPC_TIMEOUT_MS = 20_000
const MAX_BUNDLE_FILES = 500
const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 60 * 1024 * 1024

export interface SkillProbeOptions {
  workspacePath?: string
  /** Resolved pi binary; omitted (pi missing) forces the scan fallback. */
  binaryPath?: string
  /** Stub prefix under e2e — same contract as every other pi spawn. */
  prefixArgs?: string[]
  env?: Record<string, string>
}

/**
 * Dirs the last resolution produced. Every read/write/delete checks its
 * target against this set (or the writable roots), so the renderer can only
 * ever name paths this module has itself reported.
 */
const knownSkillDirs = new Set<string>()

export function skillRoots(workspacePath?: string): { userRoot: string; projectRoot?: string } {
  return {
    userRoot: join(piAgentDir(), 'skills'),
    ...(workspacePath ? { projectRoot: join(workspacePath, '.pi', 'skills') } : {}),
  }
}

function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function isWritableSkillDir(dir: string, workspacePath?: string): boolean {
  const roots = skillRoots(workspacePath)
  if (within(roots.userRoot, dir)) return true
  return roots.projectRoot ? within(roots.projectRoot, dir) : false
}

export async function resolveSkills(options: SkillProbeOptions): Promise<SkillsListResult> {
  const roots = skillRoots(options.workspacePath)
  let probe: SkillsListResult['probe'] = 'scan'
  let found: Array<{
    dir: string
    scope: SkillScope
    source: string
    origin: 'package' | 'top-level'
  }> = []

  if (options.binaryPath) {
    try {
      const viaRpc = await probeSkillsViaRpc(options)
      if (viaRpc.length > 0) {
        probe = 'rpc'
        found = viaRpc
      }
    } catch {
      // pi unavailable mid-flight — fall through to the scan.
    }
  }
  if (found.length === 0) found = await scanSkillDirs(options.workspacePath)

  const skills: ResolvedSkill[] = []
  const seen = new Set<string>()
  for (const entry of found) {
    const dir = resolve(entry.dir)
    if (seen.has(dir)) continue
    seen.add(dir)
    const enriched = await enrichSkill(dir, entry, options.workspacePath)
    if (enriched) skills.push(enriched)
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))

  knownSkillDirs.clear()
  for (const skill of skills) knownSkillDirs.add(skill.dir)
  return {
    skills,
    probe,
    userRoot: roots.userRoot,
    ...(roots.projectRoot ? { projectRoot: roots.projectRoot } : {}),
  }
}

async function probeSkillsViaRpc(
  options: SkillProbeOptions,
): Promise<
  Array<{ dir: string; scope: SkillScope; source: string; origin: 'package' | 'top-level' }>
> {
  const client = new PiRpcClient({
    cwd: options.workspacePath ?? process.cwd(),
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.prefixArgs ? { prefixArgs: options.prefixArgs } : {}),
    noSession: true,
    ...(options.env ? { env: options.env } : {}),
  })
  client.spawn()
  try {
    const response = (await withTimeout(
      client.request({ type: 'get_commands' }),
      RPC_TIMEOUT_MS,
    )) as RpcResponse<RpcResponseDataMap['get_commands']>
    if (!response.success || !response.data) return []
    const results: Array<{
      dir: string
      scope: SkillScope
      source: string
      origin: 'package' | 'top-level'
    }> = []
    for (const command of response.data.commands) {
      if (command.source !== 'skill' || !command.sourceInfo?.path) continue
      results.push({
        dir: dirname(command.sourceInfo.path),
        scope: command.sourceInfo.scope === 'project' ? 'project' : 'user',
        source: command.sourceInfo.source,
        origin: command.sourceInfo.origin,
      })
    }
    return results
  } finally {
    await client.dispose()
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('skills probe timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Fallback discovery: the two phosphor-writable roots plus any directories the
 * settings `skills` arrays point at (global resolved against the agent dir,
 * project against `<ws>/.pi`). Loose root-level `.md` skills are RPC-only —
 * the scan reports bundle dirs, which is every skill Phosphor can act on.
 */
async function scanSkillDirs(
  workspacePath?: string,
): Promise<
  Array<{ dir: string; scope: SkillScope; source: string; origin: 'package' | 'top-level' }>
> {
  const roots = skillRoots(workspacePath)
  const targets: Array<{ dir: string; scope: SkillScope }> = [
    { dir: roots.userRoot, scope: 'user' },
  ]
  if (roots.projectRoot) targets.push({ dir: roots.projectRoot, scope: 'project' })
  for (const listed of await settingsSkillDirs(piAgentDir()))
    targets.push({ dir: listed, scope: 'user' })
  if (workspacePath) {
    for (const listed of await settingsSkillDirs(join(workspacePath, '.pi'))) {
      targets.push({ dir: listed, scope: 'project' })
    }
  }
  const found: Array<{
    dir: string
    scope: SkillScope
    source: string
    origin: 'package' | 'top-level'
  }> = []
  for (const target of targets) {
    for (const dir of await findSkillBundles(target.dir, 4)) {
      found.push({ dir, scope: target.scope, source: 'scan', origin: 'top-level' })
    }
  }
  return found
}

async function settingsSkillDirs(settingsDir: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8'))
    const listed = (parsed as { skills?: unknown }).skills
    if (!Array.isArray(listed)) return []
    return listed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => {
        const expanded = entry.startsWith('~/') ? join(homedir(), entry.slice(2)) : entry
        return isAbsolute(expanded) ? expanded : resolve(settingsDir, expanded)
      })
  } catch {
    return []
  }
}

async function findSkillBundles(root: string, depth: number): Promise<string[]> {
  if (depth < 0 || !existsSync(root)) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const bundles: string[] = []
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) bundles.push(root)
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
      continue
    bundles.push(...(await findSkillBundles(join(root, entry.name), depth - 1)))
  }
  return bundles
}

async function enrichSkill(
  dir: string,
  entry: { scope: SkillScope; source: string; origin: 'package' | 'top-level' },
  workspacePath?: string,
): Promise<ResolvedSkill | null> {
  let skillMd: string
  try {
    skillMd = await readFile(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
  const { attrs } = parseSkillFrontmatter(skillMd)
  const files = await walkBundle(dir)
  const claudeUserSkills = join(homedir(), '.claude', 'skills')
  const provenance = await readSidecar(dir)
  return {
    name: attrs['name'] || basename(dir),
    description: attrs['description'] ?? '',
    dir,
    scope: entry.scope,
    source: entry.source,
    origin: entry.origin,
    writable: isWritableSkillDir(dir, workspacePath) && entry.origin !== 'package',
    borrowed: dir.includes(`${join('.claude', 'skills')}`) || within(claudeUserSkills, dir),
    draft: isSkillDraft(attrs),
    files,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    ...(provenance ? { provenance } : {}),
    warnings: skillFrontmatterWarnings(attrs),
  }
}

async function readSidecar(dir: string): Promise<SkillProvenance | undefined> {
  try {
    // Skills installed before the 2026-09-08 rename carry the old sidecar
    // name; their provenance must keep resolving. New writes use the new name.
    const raw = await readFile(join(dir, SKILL_SIDECAR), 'utf8').catch(() =>
      readFile(join(dir, LEGACY_SKILL_SIDECAR), 'utf8'),
    )
    const parsed: unknown = JSON.parse(raw)
    const p = parsed as Partial<SkillProvenance>
    if (
      typeof p.repo === 'string' &&
      typeof p.sha === 'string' &&
      typeof p.catalogId === 'string'
    ) {
      return {
        catalogId: p.catalogId,
        repo: p.repo,
        sha: p.sha,
        subpath: typeof p.subpath === 'string' ? p.subpath : '',
        installedAt: typeof p.installedAt === 'number' ? p.installedAt : 0,
      }
    }
  } catch {
    // absent or malformed — not installed by Phosphor
  }
  return undefined
}

async function walkBundle(
  dir: string,
  prefix = '',
  budget = { left: MAX_BUNDLE_FILES },
): Promise<SkillFileEntry[]> {
  let entries
  try {
    entries = await readdir(join(dir, prefix), { withFileTypes: true })
  } catch {
    return []
  }
  const files: SkillFileEntry[] = []
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name))
  // Files before subdirectories, so SKILL.md leads its bundle in the UI.
  for (const entry of sorted) {
    if (budget.left <= 0) break
    if (!entry.isFile() || entry.name === SKILL_SIDECAR || entry.name === LEGACY_SKILL_SIDECAR)
      continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    budget.left -= 1
    try {
      files.push({ path: rel, size: (await stat(join(dir, rel))).size })
    } catch {
      // raced away
    }
  }
  for (const entry of sorted) {
    if (budget.left <= 0) break
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
      continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    files.push(...(await walkBundle(dir, rel, budget)))
  }
  return files
}

/** Read one file of a known skill bundle for display/editing. */
export async function readSkillFileEntry(
  dir: string,
  rel: string,
): Promise<{ content: string | null; binary: boolean; size: number }> {
  const target = requireKnownPath(dir, rel)
  const info = await stat(target)
  if (info.size > MAX_TEXT_FILE_BYTES) return { content: null, binary: true, size: info.size }
  const data = await readFile(target)
  if (data.includes(0)) return { content: null, binary: true, size: info.size }
  return { content: data.toString('utf8'), binary: false, size: info.size }
}

function requireKnownPath(dir: string, rel: string): string {
  const base = resolve(dir)
  if (!knownSkillDirs.has(base)) throw new Error('unknown skill directory')
  const target = resolve(base, rel)
  if (target !== base && !within(base, target)) throw new Error('path escapes the skill directory')
  return target
}

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
  knownSkillDirs.add(resolve(dir))
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
  const base = resolve(dir)
  if (!knownSkillDirs.has(base)) throw new Error('unknown skill directory')
  if (!isWritableSkillDir(base, workspacePath))
    throw new Error('this skill is read-only in Phosphor')
  await rm(base, { recursive: true, force: true })
  knownSkillDirs.delete(base)
}

/** Zip a bundle for export. The provenance sidecar stays behind. */
export async function buildSkillZip(dir: string): Promise<{ fileName: string; data: Buffer }> {
  const base = resolve(dir)
  if (!knownSkillDirs.has(base)) throw new Error('unknown skill directory')
  const files = await walkBundle(base)
  const name = basename(base)
  const entries: ZipEntry[] = []
  for (const file of files) {
    entries.push({ path: `${name}/${file.path}`, data: await readFile(join(base, file.path)) })
  }
  return { fileName: `${name}.zip`, data: writeZipStore(entries) }
}

// ---------------------------------------------------------------------------
// Catalog installs

type ZipFetcher = (url: string) => Promise<Buffer>

const zipballCache = new Map<string, Promise<Buffer>>()

async function defaultFetchZip(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed (${response.status})`)
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > MAX_ARCHIVE_BYTES) throw new Error('archive exceeds the size cap')
  return data
}

export interface InstallSkillOptions {
  libraryId: string
  skillName: string
  /** Install under a different directory name (collision escape hatch). */
  targetName?: string
  /** Reinstall over an existing phosphor-installed copy (the update flow). */
  overwrite?: boolean
  fetchZip?: ZipFetcher
}

/**
 * Install one skill from a pinned catalog library into the user root.
 * Fetches the repo zipball at the pinned SHA (cached per repo@sha, so adding
 * three skills from one library downloads once) and extracts only entries
 * under the skill's subpath, through the guarded zip reader.
 */
export async function installCatalogSkill(
  options: InstallSkillOptions,
): Promise<{ dir: string; fileCount: number }> {
  const library = catalogLibrary(options.libraryId)
  if (!library) throw new Error(`unknown skill library: ${options.libraryId}`)
  if (!library.skills.some((skill) => skill.name === options.skillName)) {
    throw new Error(`"${options.skillName}" is not in ${library.label}`)
  }
  const targetName = options.targetName ?? options.skillName
  const nameError = validateSkillName(targetName)
  if (nameError) throw new Error(nameError)

  const cacheKey = `${library.repo}@${library.sha}`
  let zipball = zipballCache.get(cacheKey)
  if (!zipball) {
    const fetcher = options.fetchZip ?? defaultFetchZip
    zipball = fetcher(`https://codeload.github.com/${library.repo}/zip/${library.sha}`)
    zipballCache.set(cacheKey, zipball)
    zipball.catch(() => zipballCache.delete(cacheKey))
  }
  const entries = readZipEntries(await zipball)

  // Zipball paths start with a `<repo>-<sha>/` segment; match on what follows.
  const wanted = `${library.subpath}/${options.skillName}/`
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
  knownSkillDirs.add(resolve(dir))
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
  knownSkillDirs.add(resolve(dir))
  return { dir }
}

/** Test hook: containment checks refuse dirs no resolution has reported. */
export function _registerKnownSkillDirForTest(dir: string): void {
  knownSkillDirs.add(resolve(dir))
}
