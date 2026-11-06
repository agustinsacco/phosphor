import { utilityProcess } from 'electron'
import { createMemoryClient, type DesktopMemoryClient } from './memory-client'
import type { MemoryResponse } from './memory-protocol'

export function createDesktopMemory(directory: string, workerPath: string): DesktopMemoryClient {
  const child = utilityProcess.fork(workerPath, [directory], {
    serviceName: 'Phosphor Brain Database',
    stdio: 'ignore',
    env: {},
  })
  return createMemoryClient({
    post: (message) => child.postMessage(message),
    onMessage: (listener) => {
      child.on('message', (message: MemoryResponse) => listener(message))
    },
    onExit: (listener) => {
      child.on('exit', listener)
    },
    kill: () => {
      child.kill()
    },
  })
}
