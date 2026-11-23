import type { HostShellEnvironment } from '../../machine/shell-environment'
import type { LaneService } from '../../lanes/service'
import type { HostStore } from '../../lanes/store'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { Reach } from '@phosphor/session-runtime/ops/reach'
import type { LaneHandlerPorts } from './lane-ports'
import { archiveHandlers } from './archives'
import { artifactHandlers } from './artifacts'
import { configHandlers } from './config'
import { fileHandlers } from './files'
import { folderHandlers } from './folders'
import { gitHandlers } from './git'
import { hostsHandlers } from './hosts'
import { laneSelfHandlers } from './lane-self'
import { laneHandlers } from './lanes'
import { machineHandlers } from './machine'
import { mcpHandlers } from './mcp'
import { packageHandlers } from './packages'
import { routineHandlers } from './routines'
import { settingsHandlers } from './settings'
import { skillHandlers } from './skills'

/** What the daemon's domain handlers wrap: its existing services, never copies of them. */
export interface DaemonHandlerDeps extends LaneHandlerPorts {
  readonly store: HostStore
  /** The lane service `ops.run` sits beside: commands, calls and topics. */
  readonly lanes: LaneService
  /** The login-shell capture on a local-mode daemon; null on a headless Host. */
  readonly shellEnvironment: HostShellEnvironment | null
  /** Control's machine directory (X3 reach); absent: this machine reaches no other. */
  readonly directory?: Reach['directory']
  readonly log: RuntimeLog
}

/** Every domain file's handlers. Meta ops come from `meta.ts`, bound over the dispatcher's stores. */
export function domainHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {
    ...laneHandlers(deps),
    ...archiveHandlers(deps),
    ...artifactHandlers(deps),
    ...settingsHandlers(deps),
    ...mcpHandlers(deps),
    ...packageHandlers(deps),
    ...configHandlers(deps),
    ...skillHandlers(deps),
    ...routineHandlers(deps),
    ...folderHandlers(deps),
    ...laneSelfHandlers(deps),
    ...machineHandlers(deps),
    ...fileHandlers(deps),
    ...gitHandlers(deps),
    ...hostsHandlers(deps),
  }
}

/**
 * Catalog ops the daemon serves once their package lands, by package and
 * handler file. Until then the dispatcher answers them `unsupported`, and a
 * `ready` flag whose ops are pending is not announced. H1–H4's files exist as
 * empty stubs; P1, P2, P4b and D9 add theirs.
 */
const PENDING = {
  'H2 settings.ts':
    'settings.read settings.set directives.set instructions.read instructions.edit claude.accounts claude.routing claude.reorder account.move',
  'H2 mcp.ts': 'mcp.list mcp.check mcp.add mcp.update mcp.enable mcp.disable mcp.remove',
  'H2 packages.ts':
    'package.list package.checkUpdates package.install package.update package.remove claude.installProvider claude.installCli',
  'H2 config.ts': 'config.read config.write',
  'H3 skills.ts':
    'skill.list skill.read skill.create skill.edit skill.install skill.share skill.delete',
  'H3 routines.ts':
    'routine.list routine.history routine.activity routine.create routine.edit routine.enable routine.disable routine.run routine.cancel routine.skipNext routine.pauseAll routine.archive routine.delete',
  'H3 folders.ts': 'folder.list folder.browse folder.add folder.create folder.order folder.remove',
  'H4 lane-self.ts':
    'swarm.on swarm.off model.set thinking.set lane.rename lane.pin lane.marker pr.track pr.hide pr.clear contextFiles.set mcp.lane lane.compact lane.autoCompaction lane.autoRetry lane.queueMode lane.reload notify ui.open',
  'H4 machine.ts':
    'machine.status machine.models machine.providers machine.commands machine.usage service.update',
  'H4 files.ts':
    'files.list files.read files.write files.create files.mkdir files.trash files.rename files.transfer',
  'H4 git.ts': 'git.info git.status git.show pr.list pr.status pr.detail',
  'P1 lane-editing.ts': 'lane.tree lane.fork lane.clone lane.label lane.jump lane.rewind',
  'P2 sandboxes.ts': 'sandbox.list sandbox.create sandbox.rename sandbox.delete',
  'P4b artifact-remove.ts': 'artifact.remove',
  'D9 brain.ts': 'brain.search brain.flag',
} as const

export interface PendingHandler {
  readonly package: string
  /** Under `apps/host/src/ops/handlers/`. */
  readonly file: string
}

export const PENDING_HANDLERS: Readonly<Record<string, PendingHandler>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PENDING).flatMap(([owner, ops]) => {
      const [pkg = '', file = ''] = owner.split(' ')
      return ops.split(' ').map((name) => [name, { package: pkg, file }])
    }),
  ),
)
