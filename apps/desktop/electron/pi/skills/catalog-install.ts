/** Pinned catalog downloads and installation into the user skill root. */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { SkillProvenance } from '@shared/skills'
import type { SkillCatalogLibrary } from '@shared/skillsCatalog'
import {
  resolveCatalogBundle,
  type InstallSkillOptions,
  type BundleFile,
} from '@phosphor/session-runtime/skills/catalog'
import { registerKnownSkillDir, SKILL_SIDECAR, skillRoots, within } from './bundle'
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
