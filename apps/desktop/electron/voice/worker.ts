import { Dictation, type SpeechEngine } from './dictation'
import { createSherpaEngine } from './engine'
import type { FromVoiceWorker, ToVoiceWorker } from './protocol'

/**
 * Entry of the voice utility process (`utilityProcess.fork`, see service.ts).
 *
 * Its own process so the model's few hundred MB and its CPU never sit on
 * main, and a crash in the recognizer takes nothing else down. Messages are
 * handled one after another, so audio that arrives while the model loads
 * waits for it.
 */
let engine: SpeechEngine | null = null
let dictation: Dictation | null = null
let queue = Promise.resolve()

function post(message: FromVoiceWorker): void {
  process.parentPort.postMessage(message)
}

async function handle(message: ToVoiceWorker): Promise<void> {
  switch (message.type) {
    case 'load':
      engine = await createSherpaEngine(message.files)
      post({ type: 'loaded' })
      return
    case 'begin':
      dictation = engine ? new Dictation(engine) : null
      return
    case 'audio':
      dictation?.feed(message.samples)
      return
    case 'end': {
      const text = dictation?.finish() ?? ''
      dictation = null
      post({ type: 'text', id: message.id, text })
      return
    }
    case 'cancel':
      dictation = null
      engine?.reset()
      return
  }
}

process.parentPort.on('message', ({ data }: { data: ToVoiceWorker }) => {
  queue = queue
    .then(() => handle(data))
    .catch((error: unknown) => {
      // A failed segment ends the dictation; the next `begin` starts clean.
      dictation = null
      post({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        ...(data.type === 'end' ? { id: data.id } : {}),
      })
    })
})
