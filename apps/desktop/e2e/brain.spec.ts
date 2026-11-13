import { test, expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown } from './fixtures/local-app'
import { seedBrainLanes } from './fixtures/brain-lanes'
import {
  approveLane,
  enableBrain,
  exploreBrain,
  inbox,
  queueLane,
  resetBrain,
  status,
} from './fixtures/brain-flow'

test('Brain v4 reviews directed links, explores across lanes, retries and resets without changing lane files', async () => {
  const seed = await seedBrainLanes()
  const h = await launch({
    workspace: seed.workspace,
    agentDir: seed.agent,
    userDataDir: seed.profile,
    env: { PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1', PHOSPHOR_PI_STUB: seed.wrapper },
  })
  const { page } = h
  try {
    await enableBrain(page, seed.harbor)
    await queueLane(page, seed.harbor)
    await expect(inbox(page, seed.harbor).getByText(/Reading window \d+ of \d+/)).toBeVisible()
    await expect.poll(async () => (await status(page)).jobs[0]?.state).toBe('review')
    expect((await status(page)).counts).toEqual({ memories: 0, entities: 0 })
    const firstJob = await approveLane(page, seed.harbor)
    await expect.poll(async () => (await status(page)).counts).toEqual({ memories: 2, entities: 3 })
    const harbor = await directedGraph(page, firstJob)
    await exploreBrain(page)

    await writeFile(seed.armed, 'armed\n')
    await queueLane(page, seed.ledger)
    await expect(
      inbox(page, seed.ledger).getByRole('button', { name: 'Retry', exact: true }),
    ).toBeVisible()
    const failedJob = (await status(page)).jobs.find(
      (job) => job.sessionPath === seed.ledger.source,
    )!
    expect(failedJob.state).toBe('failed')
    expect(await readFile(join(seed.failureDirectory, 'failed-once'), 'utf8')).toBe('extract\n')
    await inbox(page, seed.ledger).getByRole('button', { name: 'Retry', exact: true }).click()
    expect(await approveLane(page, seed.ledger)).toBe(failedJob.id)
    await expect.poll(async () => (await status(page)).counts).toEqual({ memories: 4, entities: 5 })
    const combined = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
    expect(combined.nodes.filter((e) => e.label === 'Harbor').map((e) => e.id)).toEqual([harbor.id])
    const bridge = combined.nodes.find((e) => e.label === 'Ledger bridge')!
    expect(combined.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subjectId: bridge.id,
          predicate: 'part_of',
          objectId: harbor.id,
        }),
      ]),
    )
    await queueLane(page, seed.harbor)
    await expect(
      page.getByText('Nothing new in this lane since its last extraction.'),
    ).toBeVisible()
    await resetBrain(page)
    for (const lane of [seed.harbor, seed.ledger])
      expect(await readFile(lane.source, 'utf8')).toBe(lane.original)
  } catch (error) {
    const snapshot = await status(page)
    const records = await page.evaluate(
      async (ids) =>
        Promise.all(ids.map((id) => window.phosphor.invoke('brain:extraction', id).catch(String))),
      snapshot.jobs.map((job) => job.id),
    )
    await test.info().attach('brain-failure.json', {
      body: JSON.stringify({ snapshot, records }, null, 2),
      contentType: 'application/json',
    })
    throw error
  } finally {
    await shutdown(h)
  }
})

async function directedGraph(page: Page, firstJob: string) {
  const extraction = await page.evaluate(
    (id) => window.phosphor.invoke('brain:extraction', id),
    firstJob,
  )
  expect(extraction.calls.map((call) => call.stage)).toEqual([
    'extract',
    'identity',
    'parents',
    'reconcile',
  ])
  const graph = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
  const harbor = graph.nodes.find((e) => e.label === 'Harbor')!
  const rina = graph.nodes.find((e) => e.label === 'Rina Okafor')!
  const ledger = graph.nodes.find((e) => e.label === 'Harbor ledger')!
  const neighbourhood = await page.evaluate(
    (id) => window.phosphor.invoke('brain:neighbourhood', id, 2),
    rina.id,
  )
  expect(neighbourhood.links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ subjectId: rina.id, predicate: 'owns', objectId: ledger.id }),
      expect.objectContaining({
        subjectId: ledger.id,
        predicate: 'part_of',
        objectId: harbor.id,
      }),
    ]),
  )
  return harbor
}
