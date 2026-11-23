import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'
import { HARBOR_JOB } from './__fixtures__/fake-store'

const REFUSAL = 'Brain never reads its own lane.'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
/** A Brain lane folder beside the pipeline's lane, and a lane file whose header cwd is `cwd`. */
async function setup(folder: (directory: string) => string, cwd?: (directory: string) => string) {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.options.agent = { folder: folder(s.directory), turn: vi.fn() }
  if (cwd) {
    await mkdir(cwd(s.directory), { recursive: true })
    const entries = s.entries.map((e) =>
      e.type === 'session' ? { ...e, cwd: cwd(s.directory) } : e,
    )
    await writeFile(s.file, entries.map((e) => JSON.stringify(e)).join('\n'))
  }
  return s
}
async function start(s: Awaited<ReturnType<typeof setup>>, keepJobs = false) {
  if (!keepJobs) s.store.jobs = []
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  return service
}

it('refuses Queue for a lane in the Brain folder', async () => {
  const s = await setup((directory) => directory)
  const service = await start(s)
  await expect(service.api.queue({ sessionPath: s.file, title: 'Brain Agent' })).rejects.toThrow(
    REFUSAL,
  )
  expect(s.store.jobs).toEqual([])
})

it('refuses Queue for a lane in a folder inside the Brain folder, not in a sibling', async () => {
  const s = await setup(
    (directory) => join(directory, 'Brain'),
    (directory) => join(directory, 'Brain', 'notes'),
  )
  const service = await start(s)
  await expect(service.api.queue({ sessionPath: s.file, title: 'Notes' })).rejects.toThrow(REFUSAL)

  const sibling = await setup(
    (directory) => join(directory, 'Brain'),
    (directory) => join(directory, 'Brain-2'),
  )
  const other = await start(sibling)
  vi.spyOn(sibling.options.embeddings, 'status').mockReturnValue({
    ...sibling.options.embeddings.status(),
    phase: 'missing',
  })
  const queued = await other.api.queue({ sessionPath: sibling.file, title: 'Brain-2' })
  expect(queued.jobs).toHaveLength(1)
})

it('refuses Read again for a lane in the Brain folder', async () => {
  const s = await setup((directory) => directory)
  const service = await start(s)
  const done = s.store.enqueue({ ...HARBOR_JOB, sessionPath: s.file }, 'queued')
  s.store.updateJob(done.id, { state: 'done' })
  await expect(service.api.reread(done.id)).rejects.toThrow(REFUSAL)
  expect(s.store.jobs.map((job) => job.id)).toEqual([done.id])
})

it('drops a queued read of the Brain folder when it would start, without reading the lane', async () => {
  const s = await setup((directory) => directory)
  const queued = s.job
  await start(s, true)
  await vi.waitFor(() => expect(s.store.job(queued.id)).toBeUndefined())
  expect(s.runner).not.toHaveBeenCalled()
  expect(s.options.log).toHaveBeenCalledWith(
    'Brain job cancelled',
    expect.objectContaining({ jobId: queued.id, reason: REFUSAL }),
  )
})
