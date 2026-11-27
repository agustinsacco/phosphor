// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostConnectionView } from '@shared/ipc'
import { useMachineUpdatesStore } from '@/stores/machineUpdates'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { EMPTY_FOOTER } from './updatesFooterRows'
import { watchMachineUpdates } from './watchMachineUpdates'

const host: HostConnectionView = {
  state: 'ready',
  hostVersion: '1.2.0',
  connectionToken: '1',
  capabilities: [],
  repositories: [],
  lanes: [],
}
const failedRow = {
  id: 'machine' as const,
  name: 'bee1',
  text: 'Update didn’t finish',
  tone: 'warn' as const,
  title: '',
  machineId: 'bee',
}

beforeEach(() => {
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: { invoke: vi.fn(async () => undefined) },
  })
})
afterEach(() => vi.useRealTimers())

it('drops a removed machine’s update entry and footer state', () => {
  vi.useFakeTimers()
  useRemoteLanesStore.setState({ hosts: { bee: host, stark: host }, filter: 'stark' })
  const stop = watchMachineUpdates(false)
  useMachineUpdatesStore.setState((s) => ({
    byMachine: {
      ...s.byMachine,
      bee: {
        version: '1.2.0',
        run: {
          path: 'op',
          started: 1,
          shownAt: 0,
          step: 'health',
          reached: 'health',
          finish: 'download',
          settled: true,
        },
      },
    },
    footer: {
      slots: { app: EMPTY_FOOTER.slots.app, machine: { row: failedRow, since: 0 } },
      last: { app: null, machine: failedRow },
      targets: { app: null, machine: failedRow },
    },
  }))
  useRemoteLanesStore.setState({ hosts: { stark: host } })
  const { byMachine, footer } = useMachineUpdatesStore.getState()
  expect(byMachine.bee).toBeUndefined()
  expect(byMachine.stark).toBeDefined()
  expect(footer?.slots.machine.row).toBeNull()
  expect(footer?.last.machine).toBeNull()
  expect(footer?.targets.machine).toBeNull()
  stop()
})
