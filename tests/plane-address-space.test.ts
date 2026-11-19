// EVERY REQUEST THAT LEAVES FOR THE HOUSE CARRIES THE ANNOTATION, AND NO
// REQUEST THAT STAYS ON THE RELAY DOES.
//
// Local Network Access is checked per connection — the specification says the
// check "MUST be performed for each new connection made", precisely because a
// name can be re-resolved to a different address between two requests. So the
// annotation cannot live at one call site or be set once at boot: it belongs
// to the seam that already answers "is this request direct or relayed", and
// that seam is `planeRequestInit`.
//
// THE ADDRESS DECIDES, and only an address. Since the per-machine names under
// d.cookrew.dev went (2026-11-16) a name is never read for the address it
// might spell: it is a public name, and it is not annotated.
//
// The other half matters just as much. Annotating a relay request would ask
// Chrome to treat cookrew.dev as the local network, which is both false and a
// permission prompt nobody can answer honestly.

import { describe, expect, it } from 'vitest'
import { RELAY_PLANE, planeRequestInit, type DataPlane } from '../src/renderer/src/data-plane'

const DEVICE = '11111111-2222-3333-4444-555555555555'
const LAN: DataPlane = { origin: 'https://192.168.2.40:8643', kind: 'lan' }
const TAILNET: DataPlane = { origin: 'https://100.68.81.64:8643', kind: 'tailnet' }
const TAILNET6: DataPlane = { origin: 'https://[fd7a:115c:a1e0:ab12::1]:8643', kind: 'tailnet' }
const NAME: DataPlane = { origin: `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643`, kind: 'lan' }

describe('the plane’s own request options', () => {
  it('annotates a LAN plane', () => {
    expect(planeRequestInit(LAN)).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })
  })

  it('does NOT annotate a CGNAT tailnet address, which is not the local network', () => {
    // THE ANNOTATION IS AN ASSERTION, NOT A REQUEST. The spec fails a request
    // whose connection lands in a different address space from the one it
    // claimed — that IS the rebinding defence. Tailscale hands out 100.64/10,
    // which is not in any local range, so claiming 'local' for it would break
    // the tailnet plane outright on Chrome 142.
    expect(planeRequestInit(TAILNET)).toEqual({ mode: 'cors', credentials: 'omit' })
  })

  it('DOES annotate Tailscale’s ULA range, which is local by every definition', () => {
    // fd7a:115c:a1e0::/48 sits inside fc00::/7. The address decides, not the
    // word we happen to use for the network in the badge.
    expect(planeRequestInit(TAILNET6)).toEqual({
      mode: 'cors',
      credentials: 'omit',
      targetAddressSpace: 'local'
    })
  })

  it('does not read a name for the address it spells: a name is a public name', () => {
    expect(planeRequestInit(NAME)).toEqual({ mode: 'cors', credentials: 'omit' })
  })

  it('leaves a relay request alone — cookrew.dev is not the local network', () => {
    expect(planeRequestInit(RELAY_PLANE)).toEqual({ credentials: 'same-origin' })
    expect(planeRequestInit(RELAY_PLANE)).not.toHaveProperty('targetAddressSpace')
  })
})
