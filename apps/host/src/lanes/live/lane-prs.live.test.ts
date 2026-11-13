import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LanePrSignals } from '@phosphor/shared/models'
import { openStore } from '../store'
import { createLiveLanes } from '../live'

const SIGNALS: LanePrSignals = {
  opened: [{ host: 'github.com', owner: 'acme', repo: 'app', number: 7 }],
  branches: ['feat'],
  reviewing: [],
  mentioned: [],
  pinned: [],
  hidden: [],
}
const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function setup(lanePrs?: (file: string) => Promise<LanePrSignals | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), 'host-live-prs-'))
  dirs.push(dir)
  const store = await openStore(join(dir, 'state'), process.getuid?.(), { now: () => 0 })
  const repository = store.syncRepositories([dir])[0]!
  const lane = store.ensureLane({
    repositoryId: repository.id,
    cwd: dir,
    sessionFile: join(dir, 'lane.jsonl'),
  })
  const live = createLiveLanes({
    epoch: '0123456789abcdef',
    store,
    runtime: { command: vi.fn() },
    now: Date.now,
    log: vi.fn(),
    ...(lanePrs ? { lanePrs } : {}),
  })
  return { live, lane }
}

it('publishes a stopped lane again once its session file names PRs', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => SIGNALS)
  const { live, lane } = await setup(read)
  const delta = vi.spyOn(live.lanesTopic, 'delta')
  expect(live.summaryFor(lane.laneId)).not.toHaveProperty('pullRequests')
  await vi.advanceTimersByTimeAsync(250)
  expect(read).toHaveBeenCalledWith(lane.sessionFile)
  expect(delta).toHaveBeenCalledExactlyOnceWith([
    expect.objectContaining({ laneId: lane.laneId, pullRequests: SIGNALS }),
  ])
  expect(live.summaryFor(lane.laneId)?.pullRequests).toStrictEqual(SIGNALS)
})

it('leaves summaries as they were when no reader is wired', async () => {
  const { live, lane } = await setup()
  expect(live.summaryFor(lane.laneId)).not.toHaveProperty('pullRequests')
})
