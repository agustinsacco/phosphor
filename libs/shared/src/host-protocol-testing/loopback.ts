import type { FrameSocket } from '../host-protocol'
import {
  bufferedLoopbackBytes,
  closeLoopback,
  createLoopbackState,
  dropLoopbackMessages,
  scheduleLoopback,
  sendLoopback,
  type LoopbackOptions,
  type LoopbackState,
} from './loopback-state'

export type { LoopbackOptions } from './loopback-state'

function socket(state: LoopbackState, side: number, close: FrameSocket['close']): FrameSocket {
  return {
    send: (text) => sendLoopback(state, side, text),
    close,
    onMessage(cb) {
      state.messages[side]?.push(cb)
    },
    onClose(cb) {
      state.closes[side]?.push(cb)
    },
    isOpen: () => state.open,
    bufferedBytes: () => bufferedLoopbackBytes(state, side),
  }
}

/** Test transport: even paused traffic has a byte cap, and never runs inline. */
export function createLoopbackPair(options: LoopbackOptions = {}) {
  const state = createLoopbackState(options)
  const close: FrameSocket['close'] = (code, reason) => closeLoopback(state, code, reason)
  return {
    client: socket(state, 0, close),
    server: socket(state, 1, close),
    pause() {
      state.paused = true
    },
    resume() {
      state.paused = false
      scheduleLoopback(state)
    },
    dropNext(n = 1) {
      dropLoopbackMessages(state, n)
    },
    sever() {
      close(1006, 'Severed')
    },
  }
}
