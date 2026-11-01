import { writeFile } from 'node:fs/promises'
import { invalidatePiCommands } from './catalogue'
import { probeCommandsCached } from './commands'
import { installLocalSkill } from './skills/share'
import { PiUnavailableError, resolvePiInvoker } from './invoker'
import { ensureDesktopArtifactSkill } from './session-launch'
import {
  buildSkillZip,
  confirmSkillImport,
  createSkill,
  deleteSkill,
  installCatalogSkill,
  previewSkillImport,
  resolveSkills,
  writeSkillFileEntry,
  type ConfirmImportOptions,
  type CreateSkillOptions,
  type InstallSkillOptions,
  type SkillProbeOptions,
} from './skills'

/** How to ask pi for skills; without pi, no binary. Other environment errors still throw. */
async function probeOptions(workspacePath?: string): Promise<SkillProbeOptions> {
  const options: SkillProbeOptions = { ...(workspacePath ? { workspacePath } : {}) }
  try {
    const invoker = await resolvePiInvoker('minimal-stub')
    Object.assign(options, {
      binaryPath: invoker.binaryPath,
      ...(invoker.prefixArgs.length ? { prefixArgs: invoker.prefixArgs } : {}),
      env: invoker.env,
    })
  } catch (error) {
    if (!(error instanceof PiUnavailableError)) throw error
  }
  return options
}

/** Missing pi scans locally; discovery/environment errors still reach the caller. */
export async function listSkills(workspacePath?: string) {
  return resolveSkills(await probeOptions(workspacePath))
}

/**
 * A shared skill into this Mac's global skills folder. pi's global answer is read fresh (not
 * through `resolveSkills`, which would replace the Skills page's known folders); a probe that
 * fails copies nothing.
 */
export async function installSharedSkill(bundle: unknown, overwrite: unknown) {
  const commands = await probeCommandsCached(await probeOptions(), { fresh: true })
  const result = await installLocalSkill(bundle, overwrite, commands)
  if (result.status === 'installed') invalidatePiCommands()
  return result
}

/** Mutations publish a fresh command menu only after their disk work succeeds. */
async function mutateSkills<T>(mutation: () => Promise<T>): Promise<T> {
  const result = await mutation()
  invalidatePiCommands()
  return result
}

export function restoreBundledSkill(): void {
  ensureDesktopArtifactSkill(true)
  invalidatePiCommands()
}

export function createSkillAction(options: CreateSkillOptions) {
  return mutateSkills(() => createSkill(options))
}

export function writeSkillFileAction(
  dir: string,
  relPath: string,
  content: string,
  workspacePath?: string,
) {
  return mutateSkills(() => writeSkillFileEntry(dir, relPath, content, workspacePath))
}

export function deleteSkillAction(dir: string, workspacePath?: string) {
  return mutateSkills(() => deleteSkill(dir, workspacePath))
}

export function installSkillAction(
  libraryId: string,
  skillName: string,
  options?: Pick<InstallSkillOptions, 'targetName' | 'overwrite'>,
) {
  return mutateSkills(() => installCatalogSkill({ libraryId, skillName, ...(options ?? {}) }))
}

export function confirmSkillImportAction(options: ConfirmImportOptions) {
  return mutateSkills(() => confirmSkillImport(options))
}

/** Build before asking where to save; cancellation never writes an archive. */
export async function exportSkill(
  dir: string,
  chooseDestination: (fileName: string) => Promise<string | null>,
) {
  const { fileName, data } = await buildSkillZip(dir)
  const destination = await chooseDestination(fileName)
  if (!destination) return null
  await writeFile(destination, data)
  return { savedTo: destination }
}

export async function pickSkillImport(chooseSource: () => Promise<string | null>) {
  const sourcePath = await chooseSource()
  return sourcePath ? previewSkillImport(sourcePath) : null
}
