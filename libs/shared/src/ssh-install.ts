export type SshInstallStep = 'install' | 'setup' | 'login' | 'service'
export type SshInstallEvent =
  | { kind: 'progress'; step: SshInstallStep }
  | { kind: 'enrollment'; step: 'login'; code: string; fingerprint: string }
  | { kind: 'done'; step: 'service' }
  | { kind: 'failed'; step: SshInstallStep; message: string; output: string[] }
  | { kind: 'cancelled'; step: SshInstallStep }

export function validSshTarget(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.startsWith('-') &&
    /^[A-Za-z0-9._-]{1,64}(@[A-Za-z0-9._:-]{1,253})?$/.test(value)
  )
}
export function validSshRepository(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 200 &&
    (value === '' ||
      (/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,15}$/.test(value) &&
        value.split('/').every((part) => part !== '.' && part !== '..' && !part.startsWith('-'))))
  )
}
