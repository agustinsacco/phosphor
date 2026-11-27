import { describe, expect, it } from 'vitest'
import { OpRefusal } from './builtins'
import { explainJobs, JOB_HOST_HINT } from './job-explain'
import type { OpHandler, OpHandlerContext } from './types'

const ctx = {} as OpHandlerContext

function status(data: unknown, text = 'Job j: failed.'): Record<string, OpHandler> {
  return { 'job.status': async () => ({ text, data }), 'job.list': async () => ({ text: 'l' }) }
}

describe('explainJobs', () => {
  it('adds the reason to a failed or interrupted job', async () => {
    const failed = { state: 'failed', result: { text: 'lane.create: the lane could not start.' } }
    const out = await explainJobs(status(failed))['job.status']!({}, ctx)
    expect(out.text).toBe('Job j: failed.\nlane.create: the lane could not start.')
    expect(out.data).toBe(failed)
    const interrupted = { state: 'interrupted', result: { text: 'Host stopped.' } }
    expect((await explainJobs(status(interrupted))['job.status']!({}, ctx)).text).toBe(
      'Job j: failed.\nHost stopped.',
    )
  })

  it('leaves running, done and reasonless jobs as they are', async () => {
    for (const data of [
      { state: 'running', result: null },
      { state: 'done', result: { text: 'Created x.' } },
      { state: 'failed', result: null },
      null,
    ]) {
      const out = await explainJobs(status(data, 'same'))['job.status']!({}, ctx)
      expect(out.text).toBe('same')
    }
  })

  it('points a missing job at the machine that ran it', async () => {
    const handlers = explainJobs<Record<string, OpHandler>>({
      'job.status': async () => {
        throw new OpRefusal('forbidden', 'No job j that you started.')
      },
    })
    await expect(handlers['job.status']!({}, ctx)).rejects.toMatchObject({
      code: 'forbidden',
      message: `No job j that you started. ${JOB_HOST_HINT}`,
    })
  })

  it('passes other errors and handlers through', async () => {
    const boom = new OpRefusal('unavailable', 'down')
    const handlers = explainJobs<Record<string, OpHandler>>({
      'job.status': async () => {
        throw boom
      },
    })
    await expect(handlers['job.status']!({}, ctx)).rejects.toBe(boom)
    const list = status(null)
    expect(explainJobs(list)['job.list']).toBe(list['job.list'])
    expect(explainJobs({})).toEqual({})
  })
})
