import { expect, it } from 'vitest'
import { createRepositoryLocks } from './repository-lock'

function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

it('runs work on one root in turn, and reports waiting only when it must wait', async () => {
  const locks = createRepositoryLocks()
  const order: string[] = []
  const first = gate()
  const one = locks.run(
    '/repo',
    async () => {
      order.push('one')
      await first.opened
      order.push('one done')
    },
    () => order.push('one waits'),
  )
  const two = locks.run(
    '/repo',
    async () => {
      order.push('two')
    },
    () => order.push('two waits'),
  )
  await Promise.resolve()
  expect([...order].sort()).toEqual(['one', 'two waits'])
  first.open()
  await Promise.all([one, two])
  expect(order.slice(2)).toEqual(['one done', 'two'])
})

it('lets other roots run meanwhile', async () => {
  const locks = createRepositoryLocks()
  const held = gate()
  const one = locks.run('/one', () => held.opened)
  let waited = false
  await locks.run(
    '/two',
    async () => {},
    () => (waited = true),
  )
  expect(waited).toBe(false)
  held.open()
  await one
})

it('passes a failure to its caller only, and ignores a throwing waiting report', async () => {
  const locks = createRepositoryLocks()
  const failing = locks.run('/repo', () => Promise.reject(new Error('git')))
  const next = locks.run(
    '/repo',
    async () => 'next',
    () => {
      throw new Error('report')
    },
  )
  await expect(failing).rejects.toThrow('git')
  await expect(next).resolves.toBe('next')
})
