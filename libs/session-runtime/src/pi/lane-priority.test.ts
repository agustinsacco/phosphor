import { spawn, type ChildProcess } from 'node:child_process'
import { getPriority } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { applyLanePriority, LOW_LANE_PRIORITY } from './lane-priority'

let child: ChildProcess | undefined
afterEach(() => {
  child?.kill('SIGKILL')
  child = undefined
})
const start = (): ChildProcess => {
  child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' })
  return child
}
const ownPriority = getPriority()

it.skipIf(process.platform === 'win32')('lowers a lane that asks for it', () => {
  const lane = start()
  applyLanePriority(lane.pid, true, vi.fn())
  expect(getPriority(lane.pid)).toBe(LOW_LANE_PRIORITY)
})

it('leaves a lane at the owner’s priority when the setting is off', () => {
  const lane = start()
  applyLanePriority(lane.pid, false, vi.fn())
  expect(getPriority(lane.pid)).toBe(ownPriority)
})

it('logs, never throws, when the lane is already gone', () => {
  const log = vi.fn()
  const lane = start()
  const pid = lane.pid
  lane.kill('SIGKILL')
  return new Promise<void>((done) =>
    lane.once('exit', () => {
      expect(() => applyLanePriority(pid, true, log)).not.toThrow()
      expect(log).toHaveBeenCalledWith('pi', 'lane priority not applied', expect.anything())
      done()
    }),
  )
})

it('does nothing for a lane that never spawned', () => {
  const log = vi.fn()
  applyLanePriority(undefined, true, log)
  expect(log).not.toHaveBeenCalled()
})
