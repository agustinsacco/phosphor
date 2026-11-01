import { remoteSkillShare } from '@phosphor/host-client/skill-share'
import type { createHostManager } from '../hosts/manager'
import { installSharedSkill } from '../pi/skill-actions'
import { exportLocalSkill } from '../pi/skills/share'
import { handle } from './handle'

/** Skill sharing: 'local' is this Mac's skills folder; any other machine is a Host id. */
export function registerSkillShareHandlers(
  manager: Pick<ReturnType<typeof createHostManager>, 'connection'>,
): void {
  const remote = remoteSkillShare(manager.connection)
  handle('hosts:skillExport', (_event, source) => {
    if (!source || typeof source !== 'object' || typeof source.machine !== 'string')
      throw new Error('This skill cannot be shared.')
    return source.machine === 'local'
      ? exportLocalSkill(source.name, source.dir)
      : remote.export(source.machine, source.name)
  })
  handle('hosts:skillInstall', (_event, machine, bundle, overwrite) =>
    machine === 'local'
      ? installSharedSkill(bundle, overwrite)
      : remote.install(machine, bundle, overwrite === true),
  )
}
