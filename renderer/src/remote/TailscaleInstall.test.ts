import { describe, expect, it } from 'vitest'
import { tailscaleSteps } from './TailscaleInstall'

describe('tailscaleSteps', () => {
  it('gives Linux the install script, and every other system a download page', () => {
    expect(tailscaleSteps('Debian GNU/Linux')).toEqual({ kind: 'commands', lines: ['curl -fsSL https://tailscale.com/install.sh | sh', 'sudo tailscale up'] })
    expect(tailscaleSteps('Windows')).toEqual({ kind: 'download', url: 'https://tailscale.com/download/windows', os: 'Windows' })
    expect(tailscaleSteps('macOS')).toEqual({ kind: 'download', url: 'https://tailscale.com/download/mac', os: 'macOS' })
    expect(tailscaleSteps(null)).toEqual({ kind: 'download', url: 'https://tailscale.com/download', os: null })
    expect(tailscaleSteps(undefined)).toEqual({ kind: 'download', url: 'https://tailscale.com/download', os: null })
  })
})
