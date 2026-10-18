/** Shared bundle access policy and the single known-directory registry. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { piAgentDir } from '../pi-paths'
import { writeZipStore, type ZipEntry } from '../zip'
import type { SkillFileEntry, SkillProvenance } from '@shared/skills'

/** Provenance sidecar name. Dot-prefixed: skill discovery ignores dotfiles. */
export const SKILL_SIDECAR = '.phosphor-skill.json'
/** Sidecar name written by pre-rename (pidex) installs; still read, never written. */
export const LEGACY_SKILL_SIDECAR = '.pidex-skill.json'

export const MAX_BUNDLE_FILES = 500
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
export const MAX_ARCHIVE_BYTES = 60 * 1024 * 1024

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

export function within(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function isWritableSkillDir(dir: string, workspacePath?: string): boolean {
  const roots = skillRoots(workspacePath)
  if (within(roots.userRoot, dir)) return true
  return roots.projectRoot ? within(roots.projectRoot, dir) : false
}

export function replaceKnownSkillDirs(dirs: string[]): void {
  knownSkillDirs.clear()
  for (const dir of dirs) registerKnownSkillDir(dir)
}

export function registerKnownSkillDir(dir: string): void {
  knownSkillDirs.add(resolve(dir))
}

export function forgetKnownSkillDir(dir: string): void {
  knownSkillDirs.delete(resolve(dir))
}

export function requireKnownSkillDir(dir: string): string {
  const base = resolve(dir)
  if (!knownSkillDirs.has(base)) throw new Error('unknown skill directory')
  return base
}

export async function readSidecar(dir: string): Promise<SkillProvenance | undefined> {
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

export async function walkBundle(
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

export function requireKnownPath(dir: string, rel: string): string {
  const base = requireKnownSkillDir(dir)
  const target = resolve(base, rel)
  if (target !== base && !within(base, target)) throw new Error('path escapes the skill directory')
  return target
}

/** Zip a bundle for export. The provenance sidecar stays behind. */
export async function buildSkillZip(dir: string): Promise<{ fileName: string; data: Buffer }> {
  const base = requireKnownSkillDir(dir)
  const files = await walkBundle(base)
  const name = basename(base)
  const entries: ZipEntry[] = []
  for (const file of files) {
    entries.push({ path: `${name}/${file.path}`, data: await readFile(join(base, file.path)) })
  }
  return { fileName: `${name}.zip`, data: writeZipStore(entries) }
}
