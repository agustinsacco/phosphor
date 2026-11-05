/**
 * Settings → Computer use: what the @injaneity/pi-computer-use package adds,
 * and the permissions it needs. Listed only while the package is present.
 */
export function ComputerUseView({ onHost }: { onHost: boolean }): React.JSX.Element {
  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Computer use</h2>
      <p className="text-text-secondary mt-1 text-base">
        Desktop app control for macOS, Windows, and Linux, provided by{' '}
        <span className="font-mono">@injaneity/pi-computer-use</span>. After installation, Pi agents
        gain tools to observe windows, search UI elements, click, type and scroll through accessible
        interfaces.
      </p>
      <div className="mt-4 rounded-lg border border-border bg-bg-secondary/50 px-3.5 py-3 text-base">
        <p className="text-text-secondary">
          {onHost
            ? 'This extension needs a desktop session and platform-level accessibility permissions on the Host. Nobody sees a permission prompt from here: grant Accessibility and Screen Recording at the Host’s own console. Hosts do not offer this package; it is listed because pi’s settings on the Host name it.'
            : 'This extension requires platform-level accessibility permissions. On macOS, grant Accessibility and Screen Recording access to the helper when prompted.'}{' '}
          See the package docs for full setup instructions.
        </p>
      </div>
      <div className="mt-3 text-sm text-text-tertiary">
        Package:{' '}
        <a
          href="https://github.com/injaneity/pi-computer-use"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-text"
          data-tooltip="Open link"
        >
          github.com/injaneity/pi-computer-use
        </a>
      </div>
    </div>
  )
}
