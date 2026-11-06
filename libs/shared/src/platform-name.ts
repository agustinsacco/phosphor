const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }

/** A `process.platform` value in words (macOS, Linux, Windows); any other as it is. */
export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform
}
