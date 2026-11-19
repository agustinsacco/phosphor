import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { laneTitle } from './lane'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function setup() {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  vi.spyOn(s.options.embeddings, 'status').mockReturnValue({
    ...s.options.embeddings.status(),
    phase: 'missing',
  })
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  return { ...s, service }
}
it('refuses an unnamed lane when its first prompt title contains 1:1', async () => {
  const s = await setup()
  await writeFile(
    s.file,
    [
      ...s.entries.slice(0, 3),
      {
        type: 'message',
        id: 'user',
        message: { role: 'user', content: '\nTom 1:1 prep\nHarbor notes' },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  await expect(s.service.api.queue({ sessionPath: s.file, title: 'Old UI title' })).rejects.toThrow(
    'Brain never reads this lane because its title matches a rule in Settings › Brain.',
  )
  expect(s.runner).not.toHaveBeenCalled()
})
it('the newest explicit name overrides both an earlier name and the first prompt', async () => {
  const s = await setup()
  await writeFile(
    s.file,
    [
      ...s.entries,
      { type: 'session_info', name: 'Tom 1:1' },
      { type: 'session_info', name: 'Harbor planning' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const status = await s.service.api.queue({ sessionPath: s.file, title: 'Tom 1:1' })
  expect(status.jobs[0]?.title).toBe('Harbor planning')
})
it('uses the sidebar first-line title from the scanner-bounded first prompt', () => {
  expect(
    laneTitle([
      { type: 'message', message: { role: 'user', content: '\nHarbor planning\nKestrel' } },
    ]),
  ).toBe('Harbor planning')
  expect(
    laneTitle([{ type: 'message', message: { role: 'user', content: 'x'.repeat(250) } }]),
  ).toBe('x'.repeat(200))
})
it('displays Untitled lane for an empty file without matching that placeholder against a title rule', async () => {
  const s = await setup()
  s.store.prefs.neverRead = { titles: ['Untitled lane'], sessionIds: [] }
  await writeFile(
    s.file,
    s.entries
      .slice(0, 2)
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const status = await s.service.api.queue({ sessionPath: s.file, title: 'Tom 1:1' })
  expect(status.jobs[0]?.title).toBe('Untitled lane')
  expect(s.runner).not.toHaveBeenCalled()
})
