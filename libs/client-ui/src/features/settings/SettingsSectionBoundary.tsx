import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/form'

/**
 * Catches a render error in one Settings section and shows it in place, so the
 * navigation and the rest of the app keep working. Keyed by section and
 * machine in `SettingsPanel`, so switching either starts fresh.
 */
export class SettingsSectionBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Settings section crashed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        role="alert"
        data-testid="settings-section-error"
        className="border-border text-danger space-y-2 rounded-md border p-3 text-sm"
      >
        <p className="wrap-anywhere">This section couldn’t load: {error.message}</p>
        <Button onClick={() => this.setState({ error: null })}>Retry</Button>
      </div>
    )
  }
}
