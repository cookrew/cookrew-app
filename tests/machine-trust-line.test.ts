import { describe, expect, it } from 'vitest'
import { machineTrustLine } from '../src/renderer/src/zoom/machine-trust'

describe('the one line that lets this machine see the account’s others', () => {
  it('says nothing when there is nothing to see, or this machine is trusted', () => {
    expect(machineTrustLine({ trusted: false }, 0, 'darwin')).toBeNull()
    expect(machineTrustLine({ trusted: true }, 2, 'darwin')).toBeNull()
    expect(machineTrustLine(null, 2, 'darwin')).toBeNull()
  })

  it('otherwise one button: this machine signed in again on cookrew.dev, as itself, second step and all', () => {
    expect(machineTrustLine({ trusted: false }, 1, 'darwin')).toEqual({ kind: 'button', text: 'Sign this Mac in again to see your other machines' })
    expect(machineTrustLine({ trusted: false }, 1, 'linux')).toEqual({ kind: 'button', text: 'Sign this machine in again to see your other machines' })
  })
})
