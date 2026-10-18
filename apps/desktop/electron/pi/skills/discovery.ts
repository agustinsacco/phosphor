/** RPC-first skill discovery, with a labelled filesystem fallback. */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { probeCommandsCached } from '../commands'
import { packageSkillDirs } from '../packages'
import { piAgentDir } from '../pi-paths'
import {
  isSkillDraft,
  parseSkillFrontmatter,
  skillFrontmatterWarnings,
  type ResolvedSkill,
  type SkillScope,
  type SkillsListResult,
} from '@shared/skills'
import {
  isWritableSkillDir,
  readSidecar,
  replaceKnownSkillDirs,
  skillRoots,
  walkBundle,
  within,
} from './bundle'

export interface SkillProbeOptions {
  workspacePath?: string
  /** Resolved pi binary; omitted (pi missing) forces the scan fallback. */
  binaryPath?: string
  /** Stub prefix under e2e — same contract as every other pi spawn. */
  prefixArgs?: string[]
  env?: Record<string, string>
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

  replaceKnownSkillDirs(skills.map((skill) => skill.dir))
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
  const results: Array<{
    dir: string
    scope: SkillScope
    source: string
    origin: 'package' | 'top-level'
  }> = []
  // `fresh`: the page re-lists after every mutation and must see it, TTL or
  // not. The answer is stored, so the `/` menu's next open is free.
  for (const command of await probeCommandsCached(options, { fresh: true })) {
    if (command.source !== 'skill' || !command.sourceInfo?.path) continue
    results.push({
      dir: dirname(command.sourceInfo.path),
      scope: command.sourceInfo.scope === 'project' ? 'project' : 'user',
      source: command.sourceInfo.source,
      origin: command.sourceInfo.origin,
    })
  }
  return results
}

/**
 * Fallback discovery: the two phosphor-writable roots, any directories the
 * settings `skills` arrays point at (global resolved against the agent dir,
 * project against `<ws>/.pi`), and every installed package's skills. Loose
 * root-level `.md` skills are RPC-only — the scan reports bundle dirs, which
 * is every skill Phosphor can act on.
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
  for (const skill of await packageSkillDirs(workspacePath)) {
    found.push({ ...skill, origin: 'package' })
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
