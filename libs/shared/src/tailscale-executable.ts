/** Native install locations used when a GUI or service PATH omits Tailscale. */
export function tailscaleExecutableCandidates(platform: string): readonly string[] {
  switch (platform) {
    case 'darwin':
      return [
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        '/usr/local/bin/tailscale',
        '/opt/homebrew/bin/tailscale',
      ]
    case 'linux':
      return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale']
    case 'win32':
      return ['C:\\Program Files\\Tailscale\\tailscale.exe']
    default:
      return []
  }
}
