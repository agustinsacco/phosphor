import { utilityProcess } from 'electron'
import { isAbsolute } from 'node:path'
import { createMemoryClient, type BrainMemoryClient } from '@phosphor/brain-runtime/memory-client'
import type { MemoryResponse } from '@phosphor/brain-runtime/memory-protocol'

export function createDesktopMemory(directory: string, workerPath: string): BrainMemoryClient {
  if (!isAbsolute(directory) || !isAbsolute(workerPath))
    throw new Error('Brain requires absolute owned resource paths')
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
