/**
 * One dictation: audio in while the user talks, text out when they stop.
 *
 * Pure over an engine so it is testable without a model. The engine is a
 * voice detector in front of a recognizer: audio goes into the detector,
 * which hands back finished speech segments of at most a few seconds each.
 * Each segment is transcribed as soon as it closes, while the user is still
 * talking, so stopping only waits for the last one.
 */
export interface SpeechEngine {
  acceptAudio(samples: Float32Array): void
  /** Close the segment in progress, as if silence followed. */
  flush(): void
  /** The next finished segment, or null when none is waiting. */
  nextSegment(): Float32Array | null
  transcribe(segment: Float32Array): string
  /** Forget buffered audio and detector state. */
  reset(): void
}

export class Dictation {
  private readonly parts: string[] = []

  constructor(private readonly engine: SpeechEngine) {
    engine.reset()
  }

  feed(samples: Float32Array): void {
    this.engine.acceptAudio(samples)
    this.drain()
  }

  finish(): string {
    this.engine.flush()
    this.drain()
    this.engine.reset()
    return joinSegments(this.parts)
  }

  private drain(): void {
    for (let segment = this.engine.nextSegment(); segment; segment = this.engine.nextSegment()) {
      const text = this.engine.transcribe(segment).trim()
      if (text) this.parts.push(text)
    }
  }
}

/** Segments are sentences or pieces of one: a single space joins them. */
export function joinSegments(parts: string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
