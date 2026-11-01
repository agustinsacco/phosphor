import { parseMachineParams } from '@phosphor/shared/host-protocol-machine'
import {
  parseSkillBundle,
  parseSkillInstallParams,
  parseSkillInstallResult,
  type SkillBundle,
  type SkillInstallResult,
} from '@phosphor/shared/host-protocol-skill-share'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'

type Connection = (
  hostId: string,
) => Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'incarnation' | 'call'> | undefined

export const SKILL_SHARE_ERRORS = {
  configure: 'Enable configuration access on this machine to add skills to it.',
  unconfirmed:
    'The machine did not confirm the copy. Check its Skills page before trying again; nothing was retried.',
  tooLarge: 'This skill is too large to share (200 files and 4 MB at most).',
  outdated: 'Update this machine’s Host to share skills with it.',
  refused: 'The machine refused this skill.',
} as const

/**
 * Skill sharing over one Host connection, shared by Desktop and the browser. Reads need
 * `skills.read`; installs need `machine.configure`. A replaced connection or a lost capability
 * fails closed, and an install whose reply is in doubt is never retried.
 */
export function remoteSkillShare(connection: Connection) {
  async function call(hostId: string, capability: HostCapability, method: string, params: unknown) {
    const c = connection(hostId)
    const generation = c?.incarnation().generation
    const ready = () =>
      !!c &&
      connection(hostId) === c &&
      c.incarnation().generation === generation &&
      c.snapshot().state === 'ready' &&
      c.snapshot().capabilities.includes(capability)
    const install = capability === 'machine.configure'
    if (!c || !ready()) throw new Error(install ? SKILL_SHARE_ERRORS.configure : REMOTE_UNAVAILABLE)
    let result: Awaited<ReturnType<typeof c.call>>
    try {
      result = await c.call(method, params)
    } catch {
      throw new Error(install ? SKILL_SHARE_ERRORS.unconfirmed : REMOTE_UNAVAILABLE)
    }
    if (!ready()) throw new Error(install ? SKILL_SHARE_ERRORS.unconfirmed : REMOTE_UNAVAILABLE)
    if (result.ok) return result.data
    const code = result.error.code
    throw new Error(
      code === 'too-large'
        ? SKILL_SHARE_ERRORS.tooLarge
        : code === 'unsupported'
          ? SKILL_SHARE_ERRORS.outdated
          : code === 'forbidden' && install
            ? SKILL_SHARE_ERRORS.configure
            : code === 'bad-request'
              ? SKILL_SHARE_ERRORS.refused
              : REMOTE_UNAVAILABLE,
    )
  }
  return {
    async export(hostId: string, name: string): Promise<SkillBundle> {
      const params = parseMachineParams('skills.export', { name })
      if (!params) throw new Error(SKILL_SHARE_ERRORS.refused)
      const bundle = parseSkillBundle(await call(hostId, 'skills.read', 'skills.export', params))
      if (!bundle || bundle.name !== name) throw new Error(REMOTE_UNAVAILABLE)
      return bundle
    },
    async install(
      hostId: string,
      bundle: SkillBundle,
      overwrite: boolean,
    ): Promise<SkillInstallResult> {
      const params = parseSkillInstallParams({ bundle, overwrite })
      if (!params) throw new Error(SKILL_SHARE_ERRORS.refused)
      const data = await call(hostId, 'machine.configure', 'skills.install', params)
      const result = parseSkillInstallResult(data)
      if (!result) throw new Error(SKILL_SHARE_ERRORS.unconfirmed)
      return result
    },
  }
}
export type RemoteSkillShare = ReturnType<typeof remoteSkillShare>
