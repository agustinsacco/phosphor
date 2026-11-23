import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const userData = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({ app: { getPath: () => userData.path } }))
const { createBrainContribution, setSessionRecall } = await import('./brain')

const policy = (workspacePath: string) => ({ options: { workspacePath } })
const connection = { endpoint: '/tmp/ph-brain-x/rpc.sock', token: 'curator' }
const curator = {
  connection,
  extensions: ['/res/brain-ext/brain-curator.mjs'],
  skills: ['/res/skills/brain-agent'],
}
const recall = { extensions: ['/res/brain-ext/brain.mjs'], skills: ['/res/skills/brain'] }

afterEach(() => rmSync(userData.path, { recursive: true, force: true }))

it('asks Brain for the resolved folder; only the Brain lane gets the typed connection', async () => {
  userData.path = realpathSync(mkdtempSync(join(tmpdir(), 'g2-brain-contribution-')))
  const brain = join(userData.path, 'brain', 'Brain')
  mkdirSync(brain, { recursive: true })
  const contribution = createBrainContribution()
  expect(await contribution.spawn({}, policy('/repo'))).toBeUndefined()
  const launch = vi.fn(async (workspacePath: string) =>
    workspacePath === brain ? curator : recall,
  )
  setSessionRecall(launch)
  expect(await contribution.spawn({}, policy('/repo'))).toEqual(recall)
  expect(await contribution.spawn({}, policy(brain))).toEqual({
    brainConnection: connection,
    extensions: curator.extensions,
    skills: curator.skills,
  })
  expect(launch.mock.calls.map(([path]) => path)).toEqual(['/repo', brain])
})

it('never hands the connection to a lane outside the exact Brain lane folder', async () => {
  userData.path = realpathSync(mkdtempSync(join(tmpdir(), 'g2-brain-near-miss-')))
  const elsewhere = join(userData.path, 'project')
  mkdirSync(elsewhere)
  mkdirSync(join(userData.path, 'brain'))
  symlinkSync(elsewhere, join(userData.path, 'brain', 'Brain'))
  setSessionRecall(async () => curator)
  const contribution = createBrainContribution()
  for (const cwd of [elsewhere, join(userData.path, 'brain', 'Brain'), '/repo']) {
    const inputs = await contribution.spawn({}, policy(cwd))
    expect(inputs).not.toHaveProperty('brainConnection')
    expect(inputs).not.toHaveProperty('env')
  }
})
