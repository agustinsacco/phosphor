import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { DaemonHandlerDeps } from '../ops/handlers'
import { routineHandlers } from '../ops/handlers/routines'
import { createLanesTopic } from '../lanes/stream'
import { createHostRoutines } from './service'
import type { HostRuntime } from '../session/runtime'

it.each(['agent', 'ui'] as const)('publishes committed routine changes from %s', async (mode) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'routine-publication-')))
  const repositoryId = '0123456789abcdef'
  const topic = createLanesTopic({
    epoch: '0000000000000001',
    list: () => ({ lanes: [], repositories: [] }),
  })
  const seen: string[] = []
  topic.listenResources((change) => {
    if (change) seen.push(change.kind)
  })
  const routines = createHostRoutines({
    directory,
    uid: process.getuid?.(),
    store: { listRepositories: () => [{ id: repositoryId, path: directory, name: 'test' }] },
    runtime: {} as HostRuntime,
    changed: topic.routinesChanged,
    resourceChanged: topic.resourceChanged,
  })
  onTestFinished(async () => {
    await routines.close()
    await rm(directory, { recursive: true, force: true })
  })
  const definition = {
    repositoryId,
    name: 'Report',
    instructions: 'Summarize',
    isolated: false,
    provider: 'stub',
    model: 'stub-model',
    timezone: 'UTC',
    schedule: { kind: 'manual' },
    period: 'none',
    catchUpHours: 0,
    maxRuntimeMinutes: 5,
    intent: 'report',
  } as const
  const handlers = routineHandlers({
    routines,
    lanes: { calls: { call: routines.feature.call } },
  } as unknown as DaemonHandlerDeps)
  const context: OpHandlerContext = {
    principal: { kind: 'agent', laneRef: 'issuer', sessionId: 'pi', unattended: false, lineage: 0 },
    signal: new AbortController().signal,
    log: () => {},
  }
  const caps = ['routines', 'sessions.control'] as const
  const input = { ...definition, enabled: false, trusted: false }
  let id: string
  if (mode === 'agent') {
    const { data } = await handlers['routine.create']!({ definition }, context)
    id = (data as { routineId: string }).routineId
    await handlers['routine.edit']!({ id, revision: 1, patch: { name: 'Renamed' } }, context)
    await handlers['routine.archive']!({ id }, context)
  } else {
    const saved = await routines.execute(
      { type: 'routine.save', expectedRevision: null, routine: input },
      randomUUID(),
      caps,
    )
    id = (saved as { routineId: string }).routineId
    await routines.execute(
      {
        type: 'routine.save',
        routineId: id,
        expectedRevision: 1,
        routine: { ...input, name: 'Renamed' },
      },
      randomUUID(),
      caps,
    )
    await routines.execute({ type: 'routine.archive', routineId: id }, randomUUID(), caps)
  }
  expect(seen).toEqual(['routines', 'routines', 'routines'])
  expect(await routines.feature.call('routines.list', {})).toMatchObject({
    ok: true,
    data: [expect.objectContaining({ id, name: 'Renamed', archived: true })],
  })
})
