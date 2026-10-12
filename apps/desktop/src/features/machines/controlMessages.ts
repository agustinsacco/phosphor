import type { DesktopControlErrorCode } from '@shared/ipc'

export function controlMessage(code: DesktopControlErrorCode): string {
  switch (code) {
    case 'bad-request':
    case 'not-found':
    case 'gone':
      return 'That code is wrong or expired. Run phosphor login again and check the code.'
    case 'too-many-requests':
      return 'Too many tries. Wait 15 minutes before trying again.'
    case 'conflict':
      return 'The machine limit is reached, or this machine is already on an account.'
    case 'signed-out':
    case 'unauthenticated':
      return 'Sign in to your Phosphor account again.'
    case 'forbidden':
      return 'Your Phosphor account cannot add or list machines right now.'
    case 'offline':
    case 'unavailable':
      return "Cannot reach Phosphor's servers. Try again later."
    default:
      return 'Phosphor could not complete that request. Try again later.'
  }
}
