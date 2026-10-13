import { useCallback, useEffect, useRef, useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { openMic, type MicCapture } from './micCapture'

export type DictationState = 'idle' | 'starting' | 'listening' | 'transcribing'

/**
 * Click to talk, click again to get the text.
 *
 * Main starts the dictation (and the model, if it is not loaded) first, so
 * a refused microphone is reported before anything records. Audio streams to
 * main in 100 ms chunks and is transcribed while the user is still talking.
 * Failures surface as a toast; the draft is never touched by one.
 */
export function useDictation(onText: (text: string) => void): {
  state: DictationState
  toggle: () => void
} {
  const [state, setState] = useState<DictationState>('idle')
  const mic = useRef<MicCapture | null>(null)
  const stateRef = useRef<DictationState>('idle')
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const move = (next: DictationState): void => {
    stateRef.current = next
    setState(next)
  }

  const fail = (error: unknown): void => {
    useExtensionUiStore.getState().pushToast(`Dictation failed. ${ipcErrorText(error)}`, 'error')
    move('idle')
  }

  const start = async (): Promise<void> => {
    move('starting')
    try {
      await window.phosphor.invoke('voice:start')
      mic.current = await openMic((samples) => {
        void window.phosphor.invoke('voice:audio', samples).catch(() => undefined)
      })
      // Stopped (or unmounted) while the microphone was opening.
      if (stateRef.current !== 'starting') {
        await mic.current.stop()
        mic.current = null
        return
      }
      move('listening')
    } catch (error) {
      await window.phosphor.invoke('voice:cancel').catch(() => undefined)
      fail(error)
    }
  }

  const stop = async (): Promise<void> => {
    move('transcribing')
    try {
      await mic.current?.stop()
      mic.current = null
      const { text } = await window.phosphor.invoke('voice:stop')
      if (text) onTextRef.current(text)
      move('idle')
    } catch (error) {
      fail(error)
    }
  }

  // Stable: start and stop read only refs and setters.
  const toggle = useCallback(() => {
    if (stateRef.current === 'idle') void start()
    else if (stateRef.current === 'listening') void stop()
  }, [])

  // Leaving the composer mid-dictation (switching session) drops it.
  useEffect(
    () => () => {
      if (stateRef.current === 'idle') return
      stateRef.current = 'idle'
      void mic.current?.stop()
      mic.current = null
      void window.phosphor.invoke('voice:cancel').catch(() => undefined)
    },
    [],
  )

  return { state, toggle }
}
