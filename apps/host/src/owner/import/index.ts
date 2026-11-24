/** Every `owner.migrate.import` section's importer for a local-mode daemon (P4b). */
import { hostStateDirectory } from '@phosphor/shared/host-local'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import type { RunContext } from '../../commands/run'
import type { MigrationImporters } from '../migrate'
import { accountImporter } from './accounts'
import { archiveImporter } from './archives'
import { artifactImporter } from './artifacts'
import { folderImporter } from './folders'
import { laneImporter } from './lanes'
import { markImporter } from './marks'
import { policyImporter } from './policy'
import type { ImportPorts } from './ports'
import { routineImporter } from './routines'

export function sectionImporters(ports: ImportPorts): MigrationImporters {
  return {
    folders: folderImporter(ports),
    policy: policyImporter(ports),
    accounts: accountImporter(ports),
    lanes: laneImporter(ports),
    marks: markImporter(ports),
    archives: archiveImporter(ports),
    artifacts: artifactImporter(ports),
    routines: routineImporter(ports),
  }
}

export function migrationImporters(context: RunContext): MigrationImporters {
  return sectionImporters({
    stateDirectory: hostStateDirectory(context.env, context.home),
    configPath: context.configPath,
    uid: context.uid,
    sessionsRoot: piSessionsRoot(context.env, context.home),
    log: (event, fields = {}) => context.log?.('host', event, fields),
  })
}
