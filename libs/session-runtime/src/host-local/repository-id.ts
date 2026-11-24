import { createHash } from 'node:crypto'

/**
 * A Host repository's id: the first 16 hex digits of the SHA-256 of its
 * realpath. The Host store names folders by it and This Mac's migration
 * predicts it, so both must hash the same resolved path.
 */
export function repositoryIdForPath(realPath: string): string {
  return createHash('sha256').update(realPath).digest('hex').slice(0, 16)
}
