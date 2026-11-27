import { expect, it } from 'vitest'
import { parseBrainCli } from './cli-brain-args'

const generation = '6513c7c5-866b-4df8-b991-69897e1d0234'
const laneId = '859ad058-4ce3-4be5-a1ef-b03d4b0150c6'

it('requires a single explicit local target and refuses routed, absent or duplicate targets', () => {
  expect(parseBrainCli(['status', '--host', 'local', '--json'])).toEqual({
    action: { method: 'brain:status', args: [] },
    json: true,
  })
  for (const args of [
    [],
    ['--host', 'all'],
    ['--host', 'Harbor'],
    ['--host', 'local', '--host', 'local'],
  ])
    expect(parseBrainCli(['status', ...args])).toBeNull()
})

it('checks queue generation and lane identity before connecting, and maps lane commands to the reserved lane', () => {
  const queue = ['queue', '--host', 'local']
  const expected = ['--expected', `${generation}:7`]
  expect(parseBrainCli([...queue, '--args', JSON.stringify([laneId])])).toBeNull()
  expect(parseBrainCli([...queue, ...expected, '--args', '["/Harbor/Ledger"]'])).toBeNull()
  expect(parseBrainCli([...queue, ...expected, '--args', JSON.stringify([laneId])])).toEqual({
    action: { method: 'brain:queue', args: [laneId], expected: { generation, revision: 7 } },
    json: false,
  })
  expect(parseBrainCli(['lane', 'send', '--host', 'local', '--args', '["Northwind",3]'])).toEqual({
    action: { method: 'brain:laneSend', args: ['Northwind', 3] },
    json: false,
  })
})
