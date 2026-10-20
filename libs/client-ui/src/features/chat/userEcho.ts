import type { ImageContent } from '@shared/rpc'
import type { UserItem } from './chatItems'

// pi's image-process/image-resize helpers append these exact model-facing hints
// after the submitted text. They are not a second prompt. Keep this narrow:
// arbitrary extension-added prose must not confirm an unrelated local message.
const dimensionHint = String.raw`\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+\.\d{2} to map to original image\.\]`
const conversionHint = String.raw`\[Image converted from [a-z0-9.+-]+/[a-z0-9.+-]+ to [a-z0-9.+-]+/[a-z0-9.+-]+\.\]`
const imageHint = new RegExp(`^(?:${dimensionHint}|${conversionHint})$`)

/** Match only the pending local echo, allowing pi to resize/convert its images. */
export function matchesUserEcho(
  item: UserItem,
  text: string,
  images: ImageContent[] | undefined,
): boolean {
  if (item.text === text) return true
  const prefix = `${item.text}\n\n`
  return (
    !!item.images?.length &&
    item.images.length === images?.length &&
    text.startsWith(prefix) &&
    text
      .slice(prefix.length)
      .split('\n')
      .every((line) => imageHint.test(line))
  )
}
