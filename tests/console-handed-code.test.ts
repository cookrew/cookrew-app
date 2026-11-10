import { describe, expect, it } from 'vitest'
import { HANDED_CODE_KEY, landHandedCode, takeHandedCode } from '../src/renderer/src/console/handed-code'
import { pairingHandout } from '../src/main/pairing-handout'
import { renderMobileHelp } from '../src/main/mobile-cli-text'
import { memory } from './support/console-client'

/**
 * THE UNLOCK CODE, FROM A MACHINE'S OWN SCREEN TO THE CONSOLE. Unlocking a
 * machine's screen from afar goes through a sealed session the relay cannot
 * read, keyed by a code that must reach the phone without passing the relay.
 * It rides the FRAGMENT of the link the machine draws on its own screen (a QR,
 * never a terminal): `<console>/d/<machine>#code=<code>`. A fragment is never
 * sent to any server. The code opens nothing: signing in, the gate and the
 * machine's own door still stand between a scanner and the machine.
 */

const M = '0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40'
const OTHER = '11111111-1111-4111-8111-111111111111'
const CODE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ'
const machineRoute = (machine: string) => ({ kind: 'machine' as const, machine, workspace: null, agent: null, side: 'agents' as const })
const keyFor = (machine: string): string => `cr_code:${machine}`

describe('the machine’s own screen', () => {
  const deps = (code: string | null) => ({
    account: () => ({ username: 'drej', deviceId: M, name: 'Studio Mac' }),
    consoleOrigin: () => 'https://console.cookrew.dev',
    endpoints: () => [],
    pairingToken: () => 'tok',
    connectCode: () => code
  })

  it('draws the console address with the code after the #, and nothing else secret', () => {
    const handout = pairingHandout(deps(CODE))
    const url = new URL(handout?.url ?? '')
    expect(url.origin + url.pathname).toBe(`https://console.cookrew.dev/d/${M}`)
    expect(url.search).toBe('')
    expect(url.hash).toBe(`#code=${CODE}`)
    expect(handout?.url).not.toContain('tok')
  })

  it('draws the bare address when there is no code', () => {
    expect(pairingHandout(deps(null))?.url).toBe(`https://console.cookrew.dev/d/${M}`)
  })

  it('never prints the code in a terminal: `cookrew mobile` prints the address alone', () => {
    const text = renderMobileHelp({ endpoints: [], pairing: pairingHandout(deps(CODE)), secure: true, uncovered: [], tailnet: false })
    expect(text).toContain(`https://console.cookrew.dev/d/${M}`)
    expect(text).not.toContain(CODE)
    expect(text).not.toContain('#')
  })
})

describe('the console, opened at that link', () => {
  it('takes the code off the address for the machine the address names, and keeps it for this tab only', () => {
    const pending = memory()
    expect(takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })).toBe(true)
    expect(JSON.parse(pending.getItem(HANDED_CODE_KEY) ?? '{}')).toEqual({ machine: M, code: CODE })
  })

  it('takes nothing from an address that names no machine, or carries no code, or something else', () => {
    const pending = memory()
    expect(takeHandedCode({ hash: `#code=${CODE}`, route: { kind: 'devices' }, pending })).toBe(false)
    expect(takeHandedCode({ hash: '', route: machineRoute(M), pending })).toBe(false)
    expect(takeHandedCode({ hash: '#pair=a-token', route: machineRoute(M), pending })).toBe(false)
    expect(pending.all.size).toBe(0)
  })

  it('files it under that machine when that machine is entered, and under no other', () => {
    const pending = memory()
    const kept = memory()
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })
    landHandedCode({ machineId: OTHER, pending, kept, keyFor })
    expect(kept.all.size).toBe(0)
    landHandedCode({ machineId: M, pending, kept, keyFor })
    expect(kept.getItem(`cr_code:${M}`)).toBe(CODE)
    // Used: it does not wait in the tab for another machine.
    expect(pending.getItem(HANDED_CODE_KEY)).toBeNull()
  })

  it('survives the trip to the sign-in page and back, which is the same tab', () => {
    const pending = memory()
    takeHandedCode({ hash: `#code=${CODE}`, route: machineRoute(M), pending })
    // …the browser goes to the auth host and comes back: another page load, the same tab's storage.
    const kept = memory()
    landHandedCode({ machineId: M, pending, kept, keyFor })
    expect(kept.getItem(`cr_code:${M}`)).toBe(CODE)
  })
})
