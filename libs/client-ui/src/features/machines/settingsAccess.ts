import { promptChoice } from '@/stores/prompt'

/**
 * The one consent dialog for a client's configuration authority on a Host.
 * Settings and the lane's account switcher both ask before `hosts:settingsAccess`.
 */
export async function confirmSettingsAccess(label: string): Promise<boolean> {
  return (
    (await promptChoice({
      title: `Enable settings access for ${label}?`,
      message:
        'This grants this client authority to configure the Host, including reviewed code installs. It reconnects the link; running lanes stay on the Host and resync. Lane control alone does not grant this permission. Phosphor Desktop remembers this until you sign out; a browser tab forgets it when it closes.',
      choices: [{ value: 'enable', label: `Enable for ${label}`, primary: true }],
    })) === 'enable'
  )
}
