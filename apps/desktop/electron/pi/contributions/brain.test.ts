import { expect, it, vi } from 'vitest'
import { createBrainContribution, setSessionRecall } from './brain'

const policy = (workspacePath: string) => ({ options: { workspacePath } })

it('asks Brain for the resolved folder; only the Brain lane launch carries env', async () => {
  const contribution = createBrainContribution()
  expect(await contribution.spawn({}, policy('/repo'))).toBeUndefined()
  const launch = vi.fn(async (workspacePath: string) =>
    workspacePath === '/data/brain/Brain'
      ? {
          env: { PHOSPHOR_BRAIN_ENDPOINT: '/tmp/b/rpc.sock', PHOSPHOR_BRAIN_TOKEN: 'curator' },
          extensions: ['/res/brain-ext/brain-curator.mjs'],
          skills: ['/res/skills/brain-agent'],
        }
      : { extensions: ['/res/brain-ext/brain.mjs'], skills: ['/res/skills/brain'] },
  )
  setSessionRecall(launch)
  expect(await contribution.spawn({}, policy('/repo'))).toEqual({
    extensions: ['/res/brain-ext/brain.mjs'],
    skills: ['/res/skills/brain'],
  })
  expect(await contribution.spawn({}, policy('/data/brain/Brain'))).toEqual({
    env: { PHOSPHOR_BRAIN_ENDPOINT: '/tmp/b/rpc.sock', PHOSPHOR_BRAIN_TOKEN: 'curator' },
    extensions: ['/res/brain-ext/brain-curator.mjs'],
    skills: ['/res/skills/brain-agent'],
  })
  expect(launch.mock.calls.map(([path]) => path)).toEqual(['/repo', '/data/brain/Brain'])
})
