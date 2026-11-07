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
  offline: 'This machine is not connected.',
  unconfirmed:
    'The machine did not confirm the copy. Check its Skills page before trying again; nothing was retried.',
  unreadable: 'The machine could not read this skill. Try again.',
  tooLarge: 'This skill is too large to share (200 files, 2 MiB each and 4 MiB in total).',
  outdated: 'Update this machine’s Host to share skills with it.',
  refused: 'The machine refused this skill.',
} as const

/** The fixed text for a Host's refusal. `internal` covers timeouts and closed connections. */
function refusal(code: string, install: boolean): string {
  if (code === 'too-large') return SKILL_SHARE_ERRORS.tooLarge
  if (code === 'unsupported') return SKILL_SHARE_ERRORS.outdated
  if (code === 'bad-request') return SKILL_SHARE_ERRORS.refused
  if (code === 'forbidden') return install ? SKILL_SHARE_ERRORS.configure : REMOTE_UNAVAILABLE
  return install ? SKILL_SHARE_ERRORS.unconfirmed : SKILL_SHARE_ERRORS.unreadable
}

/**
 * Skill sharing over one Host connection, shared by Desktop and the browser. Reads need
 * `skills.read`; installs need `machine.configure`. A replaced connection or a lost capability
 * fails closed, and an install whose reply is in doubt is never retried. The connection resolves
 * rather than rejects a call that times out or loses its socket, as `internal`: for an install
 * that is a write in doubt.
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
    if (!c || c.snapshot().state !== 'ready') throw new Error(SKILL_SHARE_ERRORS.offline)
    if (!ready()) throw new Error(install ? SKILL_SHARE_ERRORS.configure : REMOTE_UNAVAILABLE)
    const doubt = install ? SKILL_SHARE_ERRORS.unconfirmed : SKILL_SHARE_ERRORS.unreadable
    let result: Awaited<ReturnType<typeof c.call>>
    try {
      result = await c.call(method, params)
    } catch {
      throw new Error(doubt)
    }
    if (!ready()) throw new Error(doubt)
    if (result.ok) return result.data
    throw new Error(refusal(result.error.code, install))
  }
  return {
    async export(hostId: string, name: string): Promise<SkillBundle> {
      const params = parseMachineParams('skills.export', { name })
      if (!params) throw new Error(SKILL_SHARE_ERRORS.refused)
      const bundle = parseSkillBundle(await call(hostId, 'skills.read', 'skills.export', params))
      if (!bundle || bundle.name !== name) throw new Error(SKILL_SHARE_ERRORS.unreadable)
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
