import { describe, expect, it } from 'vitest'
import { launchAgentPlist } from './launchd'
import { serviceUnit } from './systemd'

// Desktop finds a source Host's service by these names, so moving them must not change a byte.
describe('service names (characterization)', () => {
  it('renders the default LaunchAgent with the exact label and shape', () => {
    expect(
      launchAgentPlist('/n', '/b.mjs', '/c.json', '/usr/bin:/bin', '/logs', {
        XDG_STATE_HOME: '/s',
      }),
    ).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.saccolabs.phosphor-host</string>
<key>ProgramArguments</key><array><string>/n</string><string>/b.mjs</string><string>run</string><string>--config</string><string>/c.json</string><string>--supervisor</string><string>launchd</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string><key>XDG_STATE_HOME</key><string>/s</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ExitTimeOut</key><integer>30</integer>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Standard</string>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/logs/launchd.err.log</string>
</dict></plist>
`,
    )
  })
  it('renders the systemd unit with the exact shape', () => {
    expect(serviceUnit('/n', '/b.mjs', '/c.json', '/usr/bin:/bin', { XDG_STATE_HOME: '/s' })).toBe(
      '[Unit]\nDescription=Phosphor Host\n\n[Service]\nType=simple\nExecStart="/n" "/b.mjs" "run" "--config" "/c.json"\nEnvironment="PATH=/usr/bin:/bin"\nEnvironment="XDG_STATE_HOME=/s"\nRestart=on-failure\nRestartSec=10\nRestartPreventExitStatus=64 69 77 78\n\n[Install]\nWantedBy=default.target\n',
    )
  })
})
