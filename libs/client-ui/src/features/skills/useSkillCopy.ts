import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '@shared/errors'
import { bundleBytes, type SkillBundle } from '@shared/host-protocol-skill-share'
import type { ResolvedSkill } from '@shared/skills'
import { loadSkillNames } from './skillPresence'

export interface BundleSize {
  files: number
  bytes: number
}
/** One copy of a skill to one machine: read the bundle from its source, then write it there. */
export type SkillCopy =
  | { step: 'reading'; target: string }
  | ({ step: 'writing'; target: string; overwrite: boolean } & BundleSize)
  | { step: 'conflict'; target: string; replaceable: boolean; bundle: SkillBundle }
  | ({ step: 'done'; target: string; replaced: boolean } & BundleSize)
  | { step: 'failed'; target: string; message: string; read: boolean }

const sizeOf = (bundle: SkillBundle): BundleSize => ({
  files: bundle.files.length,
  bytes: bundleBytes(bundle),
})

/**
 * Runs one copy at a time. A conflict keeps the bundle it read, so Replace writes exactly what
 * the user was asked about. A write in flight cannot be dismissed: main finishes it either way,
 * and the panel must report how it ended.
 */
export function useSkillCopy(skill: Pick<ResolvedSkill, 'name' | 'dir'>, source: string) {
  const [copy, setCopy] = useState<SkillCopy | null>(null)
  const run = useRef(0)
  useEffect(
    () => () => {
      run.current++
    },
    [],
  )
  const start = useCallback(
    async (target: string, overwrite = false, read?: SkillBundle): Promise<void> => {
      const id = ++run.current
      const live = () => run.current === id
      let bundle = read
      try {
        if (!bundle) {
          setCopy({ step: 'reading', target })
          bundle = await window.phosphor.invoke('hosts:skillExport', {
            machine: source,
            name: skill.name,
            ...(source === 'local' ? { dir: skill.dir } : {}),
          })
          if (!live()) return
        }
        const size = sizeOf(bundle)
        setCopy({ step: 'writing', target, overwrite, ...size })
        const result = await window.phosphor.invoke('hosts:skillInstall', target, bundle, overwrite)
        if (!live()) return
        if (result.status === 'conflict') {
          setCopy({ step: 'conflict', target, replaceable: result.replaceable, bundle })
          return
        }
        setCopy({ step: 'done', target, replaced: result.replaced, ...size })
        void loadSkillNames(target, true)
      } catch (cause) {
        if (live()) setCopy({ step: 'failed', target, read: !bundle, message: errorText(cause) })
      }
    },
    [skill.name, skill.dir, source],
  )
  const busy = copy?.step === 'reading' || copy?.step === 'writing'
  const reset = useCallback(() => {
    if (copy?.step === 'writing') return
    run.current++
    setCopy(null)
  }, [copy])
  return { copy, busy, start, reset }
}
