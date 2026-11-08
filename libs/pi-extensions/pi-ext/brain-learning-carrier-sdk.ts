import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions } from '@phosphor/shared/version'
import type { BrainLearningPort, LearningProjection } from './brain-learning-context'

export interface LearningPiSdk {
  buildSessionProjection(entries: unknown[], leafId: string): LearningProjection
  convertToLlm: BrainLearningPort['convertToLlm']
}
/** Load the SDK from this running pi installation, not Phosphor's dependencies or a local mirror.
 * No pi executable/probe is launched. The private carrier already runs inside this installation.
 */
export async function installedLearningSdk(entry = process.argv[1]): Promise<LearningPiSdk> {
  if (!entry) throw new Error('Learning cannot locate the running pi installation')
  let directory = dirname(await realpath(entry))
  for (let depth = 0; depth < 8; depth++) {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').catch(() => '')
    if (manifest) {
      const pkg = JSON.parse(manifest) as { name?: string; version?: string; main?: string }
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        if (
          !pkg.version ||
          !/^\d+\.\d+\.\d+$/.test(pkg.version) ||
          compareVersions(pkg.version, '1.4.0') < 0 ||
          !pkg.main
        )
          throw new Error('Learning requires the installed pi >=1.4.0 SDK')
        const sdk = (await import(
          pathToFileURL(resolve(directory, pkg.main)).href
        )) as Partial<LearningPiSdk>
        if (
          typeof sdk.buildSessionProjection !== 'function' ||
          typeof sdk.convertToLlm !== 'function'
        )
          throw new Error('Learning requires pi buildSessionProjection and convertToLlm exports')
        return sdk as LearningPiSdk
      }
    }
    if (dirname(directory) === directory) break
    directory = dirname(directory)
  }
  throw new Error('Learning cannot locate the running pi SDK; no fallback SDK is permitted')
}
