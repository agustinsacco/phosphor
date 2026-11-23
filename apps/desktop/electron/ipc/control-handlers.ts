import { visibleMachines } from '../hosts/dedupe'
import { controlClient, initControlRuntime } from '../control/runtime'
import { handle } from './handle'

export { controlClient, onMachinesChanged } from '../control/runtime'

export function registerControlHandlers(): void {
  initControlRuntime()
  const client = controlClient()
  handle('control:machines', async () => visibleMachines(await client.machines()))
  handle('control:lookupEnrollment', (_event, code) => client.lookupEnrollment(code))
  handle('control:approveEnrollment', (_event, code, label) =>
    client.approveEnrollment(code, label),
  )
  handle('control:renameMachine', (_event, id, label) => client.renameMachine(id, label))
  handle('control:removeMachine', (_event, id) => client.removeMachine(id))
  handle('control:setMachineReach', (_event, id, enabled) => client.setMachineReach(id, enabled))
}
