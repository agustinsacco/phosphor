import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** A shipped default becomes an ordinary, user-owned pi skill. */
export const ARTIFACT_SKILL = 'visual-artifacts'

/**
 * Seed once per pi configuration, not per app version. The receipt is outside
 * the skill: deleting the skill must not cause its resurrection on restart.
 * Existing bundles (including symlinks) always win. Restoring is explicit and
 * only fills an absent bundle; it never overwrites somebody's edits.
 */
export function seedArtifactSkill(resourceRoot: string, agentDir: string, restore = false): string {
  const state = join(agentDir, '.phosphor-bundled-skills')
  const receipt = join(state, ARTIFACT_SKILL)
  const target = join(agentDir, 'skills', ARTIFACT_SKILL)
  if (!restore && existsSync(receipt)) return target
  mkdirSync(state, { recursive: true })
  const present = (): boolean => {
    try {
      lstatSync(target)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
  }
  if (!present()) {
    const staging = mkdtempSync(join(state, 'install-'))
    try {
      const source = join(resourceRoot, 'skills', ARTIFACT_SKILL)
      if (!existsSync(join(source, 'SKILL.md')))
        throw new Error('Bundled visual-artifacts skill is missing')
      const prepared = join(staging, ARTIFACT_SKILL)
      cpSync(source, prepared, { recursive: true, errorOnExist: true, force: false })
      mkdirSync(join(agentDir, 'skills'), { recursive: true })
      // Never expose half a bundle to pi's resource discovery.
      if (!present()) {
        try {
          renameSync(prepared, target)
        } catch (error) {
          // A concurrent installer may have won. Do not replace its bundle.
          if (!present()) throw error
        }
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  writeFileSync(receipt, 'Installed once. Edits and removal are user-owned.\n')
  return target
}
