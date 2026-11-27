import { OP_CATALOG } from './domains/catalog'

const desktop = new Set([
  'help',
  'whoami',
  'policy.show',
  'policy.set',
  'audit.list',
  'audit.undo',
  'confirm.info',
  'confirm.list',
  'confirm.status',
  'confirm.approve',
  'confirm.deny',
  'swarm.on',
  'swarm.off',
  'model.set',
  'thinking.set',
  'lane.rename',
  'lane.pin',
  'lane.marker',
  'pr.track',
  'pr.hide',
  'pr.clear',
  'contextFiles.set',
  'lane.compact',
  'lane.autoCompaction',
  'lane.autoRetry',
  'lane.queueMode',
  'notify',
  'lane.list',
  'lane.search',
  'lane.tree',
  'lane.controls',
  'folder.list',
  'sandbox.list',
  'lane.read',
  'archive.list',
  'artifact.list',
  'artifact.read',
  'routine.list',
  'routine.history',
  'routine.activity',
  'skill.list',
  'skill.read',
  'settings.read',
  'mcp.list',
  'mcp.check',
  'claude.accounts',
  'package.list',
  'package.checkUpdates',
  'directives.read',
  'machine.status',
  'machine.doctor',
  'machine.models',
  'machine.providers',
  'machine.commands',
  'machine.usage',
  'brain.search',
  'brain.flag',
  'brain.status',
  'brain.find',
  'brain.queue',
])
const moveNotice =
  'This Mac gets this once Phosphor finishes moving its lanes to the Phosphor service.'
const jobNotice =
  "Background operations run on the Phosphor service; this Mac hasn't moved its lanes there yet."
const desktopGap: Readonly<Record<string, string>> = {
  'folder.browse': 'Use the app’s folder picker until this Mac moves to the Phosphor service.',
  'lane.message': 'Agent messages need the Phosphor service’s lane command queue. ' + moveNotice,
  'lane.wait':
    'Waiting on another lane needs the Phosphor service’s activity stream. ' + moveNotice,
  'job.list': jobNotice,
  'job.status': jobNotice,
}
const daemon = [
  'brain.find',
  'brain.queue',
  'brain.status',
  'mcp.expose',
  'routine.check',
  'routine.fromLane',
  'files.search',
  'maintenance.scan',
  'maintenance.run',
]

/** Positive gap lists, not permission grants. A never-tier denial takes precedence. */
export const OP_GAPS: Readonly<
  Record<'daemon' | 'desktop', Readonly<Partial<Record<string, string>>>>
> = Object.freeze({
  desktop: Object.freeze(
    Object.fromEntries(
      OP_CATALOG.filter((op) => !desktop.has(op.name)).map((op) => [
        op.name,
        desktopGap[op.name] ?? moveNotice,
      ]),
    ),
  ),
  daemon: Object.freeze({
    'lane.move':
      "Moving a lane between machines runs from the Phosphor app: open the lane's menu and choose Move to…",
    'skill.share':
      'The Phosphor service cannot copy skills between machines; share skills from the Phosphor app.',
    ...Object.fromEntries(
      daemon.map((name) => [name, `${name} is not available through the Phosphor service.`]),
    ),
  }),
})
