/**
 * Brain stores an untitled lane's title as '', so no title rule can match a placeholder. This is
 * the one place a Brain job or memory source gets its on-screen name.
 */
export function brainLaneTitle(title: string): string {
  return title || 'Untitled lane'
}
