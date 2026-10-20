'use strict'

/** Simulate pi's post-resize prompt echo, without doing image processing here. */
module.exports = function echoImagePrompt(cmd, out, persist) {
  if (process.env.PHOSPHOR_E2E_IMAGE_HINTS !== '1' || !cmd.images?.length) return
  const hints = cmd.images.map(
    () =>
      '[Image: original 2246x1072, displayed at 2000x955. Multiply coordinates by 1.12 to map to original image.]',
  )
  const message = {
    role: 'user',
    content: [{ type: 'text', text: `${cmd.message}\n\n${hints.join('\n')}` }, ...cmd.images],
    timestamp: Date.now(),
  }
  persist(message)
  out({ type: 'message_start', message })
  out({ type: 'message_end', message })
}
