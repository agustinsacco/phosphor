import { describe, expect, it } from 'vitest'
import { Dictation, joinSegments, type SpeechEngine } from './dictation'

/**
 * A detector that closes a segment every `size` samples and a recognizer
 * that reads each one back as the next scripted phrase.
 */
function fakeEngine(phrases: string[], size = 4) {
  let buffered = 0
  const ready: Float32Array[] = []
  const transcribed: number[] = []
  const engine: SpeechEngine & { transcribed: number[]; resets: number } = {
    transcribed,
    resets: 0,
    acceptAudio(samples) {
      buffered += samples.length
      while (buffered >= size) {
        ready.push(new Float32Array(size))
        buffered -= size
      }
    },
    flush() {
      if (buffered > 0) ready.push(new Float32Array(buffered))
      buffered = 0
    },
    nextSegment: () => ready.shift() ?? null,
    transcribe(segment) {
      transcribed.push(segment.length)
      return phrases.shift() ?? ''
    },
    reset() {
      engine.resets++
      buffered = 0
      ready.length = 0
    },
  }
  return engine
}

describe('Dictation', () => {
  it('transcribes segments as they close, while audio is still arriving', () => {
    const engine = fakeEngine(['Hello there.', 'Second part.'])
    const dictation = new Dictation(engine)
    dictation.feed(new Float32Array(5))
    expect(engine.transcribed).toEqual([4])
    dictation.feed(new Float32Array(2))
    expect(dictation.finish()).toBe('Hello there. Second part.')
    expect(engine.transcribed).toEqual([4, 3])
  })

  it('drops empty segments, and leaves the engine clean for the next one', () => {
    const engine = fakeEngine(['  ', ' Only this. '])
    const dictation = new Dictation(engine)
    dictation.feed(new Float32Array(8))
    expect(dictation.finish()).toBe('Only this.')
    expect(engine.resets).toBe(2)
  })

  it('returns nothing for silence', () => {
    expect(new Dictation(fakeEngine([])).finish()).toBe('')
  })
})

describe('joinSegments', () => {
  it('joins with single spaces', () => {
    expect(joinSegments(['a  b', ' c'])).toBe('a b c')
  })
})
