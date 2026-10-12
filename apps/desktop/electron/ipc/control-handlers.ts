import { app } from 'electron'
import { accountAccessToken, accountControlGeneration } from '../account'
import { controlUrl, createControlClient } from '../control/client'
import { handle } from './handle'

const client = createControlClient({
  baseUrl: () => controlUrl(app.isPackaged, process.env),
  accessToken: accountAccessToken,
  generation: accountControlGeneration,
})

export function registerControlHandlers(): void {
  handle('control:machines', () => client.machines())
  handle('control:lookupEnrollment', (_event, code) => client.lookupEnrollment(code))
  handle('control:approveEnrollment', (_event, code, label) =>
    client.approveEnrollment(code, label),
  )
  handle('control:removeMachine', (_event, id) => client.removeMachine(id))
}
