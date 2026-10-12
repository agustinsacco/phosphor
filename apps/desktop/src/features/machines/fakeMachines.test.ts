import { describe, expect, it } from 'vitest'
import {
  FAKE_LANES,
  LOCAL_MACHINE,
  ago,
  finishLane,
  lanesForProject,
  lanesOnFilter,
  localMachineName,
  machineById,
  machineStatus,
  nextToFinish,
  remoteOnlyProjects,
  showsLocal,
  type RemoteLane,
} from './fakeMachines'

const lane = (id: string, machineId: string, project: string, state: RemoteLane['state']) => ({
  id,
  machineId,
  project,
  title: id,
  branch: `b/${id}`,
  state,
  minutesAgo: 5,
})

describe('the machine filter', () => {
  it('shows this computer under All and its own entry only', () => {
    expect(showsLocal('all')).toBe(true)
    expect(showsLocal(LOCAL_MACHINE)).toBe(true)
    expect(showsLocal('bee1')).toBe(false)
  })

  it('keeps every remote lane under All, one machine under its id, none under this computer', () => {
    expect(lanesOnFilter(FAKE_LANES, 'all')).toEqual(FAKE_LANES)
    expect(lanesOnFilter(FAKE_LANES, 'bee2').map((l) => l.id)).toEqual(['bee2-e2e'])
    expect(lanesOnFilter(FAKE_LANES, LOCAL_MACHINE)).toEqual([])
  })
})

describe('projects across machines', () => {
  const lanes = [
    lane('a', 'bee1', 'phosphor', 'running'),
    lane('b', 'bee2', 'Phosphor', 'idle'),
    lane('c', 'bee1', 'brigades', 'idle'),
    lane('d', 'bee2', 'brigades', 'idle'),
    lane('e', 'bee1', 'site', 'idle'),
  ]

  it('puts a remote lane in the local project of the same name, whatever its case', () => {
    expect(lanesForProject(lanes, 'PHOSPHOR ').map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('groups the projects this computer does not have, in lane order', () => {
    expect(remoteOnlyProjects(lanes, ['Phosphor'])).toEqual([
      { name: 'brigades', lanes: [lanes[2], lanes[3]] },
      { name: 'site', lanes: [lanes[4]] },
    ])
    expect(remoteOnlyProjects(lanes, ['phosphor', 'Brigades', 'site'])).toEqual([])
  })
})

describe('the finish demo', () => {
  it('ends the first live lane on a machine that is up, and only that one', () => {
    const lanes = [
      lane('down', 'bee2', 'phosphor', 'running'),
      lane('idle', 'bee1', 'phosphor', 'idle'),
      lane('waits', 'bee1', 'phosphor', 'waiting'),
      lane('runs', 'bee1', 'phosphor', 'running'),
    ]
    expect(nextToFinish(lanes)?.id).toBe('waits')
    const after = finishLane(lanes, 'waits')
    expect(after.map((l) => l.state)).toEqual(['running', 'idle', 'done', 'running'])
    expect(after[2]?.minutesAgo).toBe(0)
    expect(nextToFinish(after)?.id).toBe('runs')
    expect(nextToFinish(finishLane(after, 'runs'))).toBeUndefined()
  })
})

describe('labels', () => {
  it('says how long ago in seconds, minutes or hours', () => {
    expect(ago(0.2)).toBe('12 s')
    expect(ago(9)).toBe('9 min')
    expect(ago(190)).toBe('3 h')
  })

  it('reads an up machine by when it was seen and a down one by how long', () => {
    expect(machineStatus(machineById('bee1')!)).toBe('up · seen 12 s ago')
    expect(machineStatus(machineById('bee2')!)).toBe('down 3 h')
  })

  it('names this computer for its platform', () => {
    expect(localMachineName('darwin')).toEqual({ long: 'This Mac', short: 'Mac' })
    expect(localMachineName('linux')).toEqual({ long: 'This computer', short: 'Local' })
  })
})
