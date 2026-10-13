import { join } from 'node:path'
import { app, systemPreferences, utilityProcess } from 'electron'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { getPrefs, setVoicePrefs } from '../store'
import type { FromVoiceWorker, ToVoiceWorker } from './protocol'
import { createVoiceService, type VoiceService, type VoiceWorker } from './service'

/** `worker.ts`, built beside main.js as its own entry (electron.vite.config.ts). */
const workerPath = join(import.meta.dirname, 'voice-worker.js')

let service: VoiceService | null = null

/** The one voice service, bound to Electron. Constructed on first use, after ready. */
export function voiceService(): VoiceService {
  service ??= createVoiceService({
    dir: join(app.getPath('userData'), 'voice'),
    loadPrefs: () => getPrefs().voice,
    savePrefs: setVoicePrefs,
    publish: (status) => broadcast('voice:statusChanged', status),
    spawnWorker,
    allowMicrophone,
    log: (message) => log('voice', message),
  })
  return service
}

function spawnWorker(): VoiceWorker {
  const child = utilityProcess.fork(workerPath, [], {
    serviceName: 'Phosphor Voice',
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => log('voice', chunk.toString().slice(0, 2000)))
  return {
    post: (message: ToVoiceWorker) => child.postMessage(message),
    onMessage: (listener) => child.on('message', (message: FromVoiceWorker) => listener(message)),
    onExit: (listener) => child.on('exit', () => listener()),
    kill: () => void child.kill(),
  }
}

/**
 * macOS asks once and remembers per app; the answer lives in System Settings
 * → Privacy & Security → Microphone. Windows has a global switch that
 * `getMediaAccessStatus` reports. Linux has no OS gate to ask.
 */
async function allowMicrophone(): Promise<boolean> {
  if (process.platform === 'linux') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (process.platform === 'darwin' && status === 'not-determined') {
    return systemPreferences.askForMediaAccess('microphone')
  }
  return status !== 'denied' && status !== 'restricted'
}
