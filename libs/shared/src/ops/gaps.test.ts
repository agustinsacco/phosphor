import { expect, it } from 'vitest'
import { OP_CATALOG, OP_GAPS } from './index'

it('keeps only the reviewed Phosphor service gaps', () => {
  const expected =
    `lane.move skill.share brain.find brain.queue brain.status mcp.expose routine.check routine.fromLane
 git.branches git.worktrees git.diff git.fetch git.pull git.updateFromMain git.commitAll git.checkout git.renameBranch git.restoreFile git.merge
 worktree.add worktree.remove worktree.prune worktree.restore worktree.recreate files.search maintenance.scan maintenance.run`
      .trim()
      .split(/\s+/)
  expect(Object.keys(OP_GAPS.daemon).sort()).toEqual(expected.sort())
  expect(
    Object.entries(OP_GAPS.daemon).every(
      ([op, reason]) => op === 'lane.move' || reason?.includes('Phosphor service'),
    ),
  ).toBe(true)
  expect(OP_GAPS.daemon['lane.move']).toBe(
    "Moving a lane between machines runs from the Phosphor app: open the lane's menu and choose Move to…",
  )
  expect(OP_CATALOG.map((op) => op.name)).toEqual(expect.arrayContaining(expected))
})
it('declares every owner-goal operation without a service gap', () => {
  const goals =
    `settings.read settings.set directives.set instructions.read instructions.edit config.read config.write
 mcp.list mcp.check mcp.add mcp.update mcp.enable mcp.disable mcp.remove mcp.lane package.list package.checkUpdates package.install package.update package.remove
 skill.list skill.read skill.create skill.edit skill.delete skill.install routine.list routine.history routine.activity routine.create routine.edit routine.enable routine.disable routine.run routine.cancel routine.skipNext routine.pauseAll routine.archive routine.delete
 swarm.on swarm.off model.set thinking.set pr.track pr.hide pr.clear contextFiles.set lane.compact lane.autoCompaction lane.autoRetry lane.queueMode lane.reload
 lane.create lane.list lane.search lane.read lane.stop lane.archive lane.resume lane.delete lane.tree lane.fork lane.clone lane.label lane.jump lane.rewind
 archive.list archive.restore archive.purge artifact.list artifact.read artifact.remove hosts.list folder.list sandbox.create sandbox.list sandbox.rename sandbox.delete machine.status machine.doctor`
      .trim()
      .split(/\s+/)
  expect(
    OP_CATALOG.filter((op) => !Object.hasOwn(OP_GAPS.daemon, op.name)).map((op) => op.name),
  ).toEqual(expect.arrayContaining(goals))
})
it('offers only the pre-migration subset and explains every other op', () => {
  const available =
    `help whoami policy.show policy.set audit.list audit.undo confirm.info confirm.list confirm.status confirm.approve confirm.deny swarm.on swarm.off model.set thinking.set lane.rename lane.pin lane.marker pr.track pr.hide pr.clear contextFiles.set lane.compact lane.autoCompaction lane.autoRetry lane.queueMode notify lane.list lane.search lane.tree lane.controls folder.list sandbox.list lane.read archive.list artifact.list artifact.read routine.list routine.history routine.activity skill.list skill.read settings.read mcp.list mcp.check claude.accounts package.list package.checkUpdates directives.read machine.status machine.doctor machine.models machine.providers machine.commands machine.usage brain.search brain.flag brain.status brain.find brain.queue`.split(
      ' ',
    )
  expect(
    OP_CATALOG.filter((op) => !Object.hasOwn(OP_GAPS.desktop, op.name))
      .map((op) => op.name)
      .sort(),
  ).toEqual(available.sort())
  expect(new Set(Object.values(OP_GAPS.desktop))).toEqual(
    new Set([
      'This Mac gets this once Phosphor finishes moving its lanes to the Phosphor service.',
    ]),
  )
})

it('explains Desktop folder browsing and background-job gaps at the point of use', () => {
  expect(OP_GAPS.desktop['folder.browse']).toMatch(/folder picker/i)
  for (const op of ['job.list', 'job.status'])
    expect(OP_GAPS.desktop[op]).toMatch(/background operations run on the Phosphor service/i)
})
