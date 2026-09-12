# Boot the packaged Windows build once and prove it can run pi.
#
# The unit tests cover the launcher's string work (electron/pi/win-launch.ts)
# on every platform, but only a real Windows process can show that the
# packaged app starts, `where pi` finds npm's shim, the shim is read through to
# node.exe + cli.js, and `pi --version` answers. The main process writes one
# `[pi] health {...}` line to its debug log per fresh probe
# (electron/ipc/pi-session-handlers.ts); this script waits for it and asserts
# `"ok":true`. A main-process throw would land in the same log as
# `uncaughtException`, so that fails the smoke too.
#
# Run from the repo root after `electron-builder --win`:
#   pwsh scripts/smoke-packaged-win.ps1
param(
  [string]$Exe = 'release\win-unpacked\Phosphor.exe',
  [int]$TimeoutSec = 120
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Exe)) { throw "packaged app not found at $Exe" }
# Electron's `logs` path on Windows: %APPDATA%\<productName>\logs.
$log = Join-Path $env:APPDATA 'Phosphor\logs\phosphor.log'
if (Test-Path $log) { Remove-Item $log -Force }

$proc = Start-Process -FilePath $Exe -PassThru
try {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $health = $null
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { throw "Phosphor exited before probing pi (exit code $($proc.ExitCode))" }
    if (Test-Path $log) {
      $health = Select-String -Path $log -Pattern '\[pi\] health ' | Select-Object -First 1
      if ($health) { break }
    }
    Start-Sleep -Seconds 1
  }

  Write-Host '--- phosphor.log ---'
  if (Test-Path $log) { Get-Content $log | Write-Host } else { Write-Host '(no log file)' }
  Write-Host '--------------------'

  if (-not $health) { throw "no '[pi] health' line within ${TimeoutSec}s" }
  if ($health.Line -notmatch '"ok":true') { throw "pi health probe failed: $($health.Line)" }
  if (Select-String -Path $log -Pattern 'uncaughtException|unhandledRejection' -Quiet) {
    throw 'the main process logged an error during boot'
  }
  Write-Host 'packaged app booted and ran pi'
} finally {
  # /T: the whole Electron tree (renderer, GPU, utility processes), not only
  # the browser process.
  if (-not $proc.HasExited) { & taskkill /PID $proc.Id /T /F | Out-Null }
}
