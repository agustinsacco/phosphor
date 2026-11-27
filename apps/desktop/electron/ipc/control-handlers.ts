import { visibleMachines } from '../hosts/dedupe'
import { activateRemoteAccess, controlClient, initControlRuntime } from '../control/runtime'
import { handle } from './handle'
import { ownerKeyAccess } from '../local-machine/owner-key-access'

export { controlClient, onMachinesChanged } from '../control/runtime'

export function registerControlHandlers(): void {
  initControlRuntime()
  const client = controlClient()
  // The account token and the service key share one protected store. Once this
  // run has opened it, discovery costs no prompt, so a signed-in launch shows its
  // machines without waiting for a Machines visit.
  const startWhenOpened = () => {
    if (ownerKeyAccess.opened()) activateRemoteAccess()
  }
  ownerKeyAccess.onChange(startWhenOpened)
  startWhenOpened()
  handle('control:machines', async () => {
    activateRemoteAccess()
    return visibleMachines(await client.machines())
  })
  handle('control:lookupEnrollment', (_event, code) => client.lookupEnrollment(code))
  handle('control:approveEnrollment', (_event, code, label) =>
    client.approveEnrollment(code, label),
  )
  handle('control:renameMachine', (_event, id, label) => client.renameMachine(id, label))
  handle('control:removeMachine', (_event, id) => client.removeMachine(id))
  handle('control:setMachineReach', (_event, id, enabled) => client.setMachineReach(id, enabled))
}
