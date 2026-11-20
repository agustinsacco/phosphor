import { decideRead } from './__fixtures__/decide-read'
import { unlink } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
it.each(['never-read', 'deleted'] as const)(
  'loads a stale %s proposal so the owner can see an approval refusal and reject it',
  async (kind) => {
    const s = await pipelineSetup()
    cleanups.push(s.cleanup)
    s.store.jobs = []
    const service = await createBrainService(s.options)
    cleanups.push(() => service.dispose())
    const id = (await service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
    await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
    s.runner.mockClear()
    if (kind === 'never-read') await service.api.neverRead('harbor-lane', true)
    else await unlink(s.file)
    s.store.rev++
    await service.api.setPrefs(s.store.prefs)
    if (kind === 'deleted') {
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(s.store.job(id)?.state).toBe('review')
    }
    await expect(service.api.proposal(id)).resolves.toMatchObject({ revision: 0 })
    const proposal = await service.api.proposal(id)
    expect(proposal.revision).toBe(0)
    expect(proposal.memories).toHaveLength(1)
    await expect(
      decideRead(
        service,
        id,
        {
          memories: [0],
          identities: {},
          groups: [],
          descriptions: [],
          confirmations: [],
        },
        proposal.revision,
      ),
    ).rejects.toThrow(
      kind === 'never-read'
        ? "Brain changed since this was read, and this lane is set to never be read, so it can't be refreshed. Reject it instead."
        : "This lane was deleted, so this review can't be refreshed. Reject it.",
    )
    await expect(decideRead(service, id, null, proposal.revision)).resolves.toMatchObject({
      jobs: [],
    })
    expect(s.store.job(id)?.state).toBe('rejected')
    expect(s.runner).not.toHaveBeenCalled()
  },
)
