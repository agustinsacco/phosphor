/**
 * Filler shown while a prompt is out but pi has not started the turn yet.
 *
 * The gap is real work — spawning the provider CLI, resuming a session,
 * waiting on the first byte from the model — and it can run for many seconds.
 * Before this, the chat showed the user's own bubble and nothing else, which
 * reads as "the app dropped it".
 *
 * Rude to the machine, never to the user: every line blames pi, the GPUs, the
 * model or the bill. Keep it that way when adding more.
 */
export const BOOT_PHRASES: readonly string[] = [
  'Waking the model. It slept through its alarm…',
  'Bribing a GPU with your money…',
  'Booting pi. It is still putting its pants on…',
  'Warming up the hallucination engine…',
  'Loading opinions nobody asked for…',
  'Yelling at silicon until it complies…',
  'Negotiating with the rate limiter…',
  'Spinning up a very expensive autocomplete…',
  'Telling the model to read the docs. It will not…',
  'Rummaging through your repo, judging quietly…',
  'Pretending to think really hard…',
  'Counting your tokens. Wincing…',
  'Reticulating splines, allegedly…',
  'Asking nicely. Escalating shortly…',
  'Summoning something that cannot be fired…',
  'Consulting the machine that lies confidently…',
  'Untangling the last agent’s mess…',
  'Rolling for initiative…',
]

/** ms one phrase stays up before the next. Long enough to read, short enough to feel alive. */
export const BOOT_PHRASE_MS = 3500

/**
 * Phrase for a session at a given tick.
 *
 * Seeded by session id so two lanes booting side by side do not chant the
 * same line in unison, and stepped by tick so one session does not repeat
 * itself while it waits.
 */
export function bootPhrase(seed: string, tick: number): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  const start = Math.abs(hash) % BOOT_PHRASES.length
  return BOOT_PHRASES[(start + tick) % BOOT_PHRASES.length] ?? BOOT_PHRASES[0]!
}
