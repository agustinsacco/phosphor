import { backupConfig, liveConfig, writeConfig } from '../../prefs/migration-config'
import type { PostCommitInput, PostCommitSteps } from './post-commit'
import { parkRoutines, quarantineConfig, type RoutinesFile } from './quarantine'
import { rekeyDevice } from './rekey'

function saved(input: PostCommitInput) {
  const { plan, journal } = input
  if (
    journal.state !== 'committed' ||
    !journal.machineId ||
    plan.machineId !== journal.machineId ||
    plan.migrationId !== journal.migrationId
  )
    throw new Error('The plan does not identify this committed migration.')
  return { config: backupConfig(input.backupDir, journal.migrationId), host: journal.machineId }
}
export function createPostCommitSteps(ports: { routinesFile: RoutinesFile }): PostCommitSteps {
  return {
    device: async (input) => {
      const { config, host } = saved(input)
      const { fields, orphans } = rekeyDevice(config, input.plan, host)
      writeConfig(input.userData, { ...liveConfig(input.userData), ...fields })
      input.log('device-rekey', { orphans })
    },
    quarantine: async (input) => {
      saved(input)
      const next = quarantineConfig(liveConfig(input.userData))
      parkRoutines(input.userData, ports.routinesFile, input.journal.migrationId)
      writeConfig(input.userData, next)
    },
  }
}
