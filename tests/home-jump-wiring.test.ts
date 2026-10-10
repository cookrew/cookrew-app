// THE WIRING: the knocks run after a race only on the platform offer, the
// report carries them, and the navigation is the decision's and nobody else's.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('coming home is wired through the one decision', () => {
  const companion = readFileSync('src/renderer/src/path/companion.ts', 'utf8')
  const server = readFileSync('src/main/mobile-server.ts', 'utf8')

  it('the page knocks (reach-probes) and jumps only through homeJump', () => {
    expect(companion).toContain("import { probeReach, type ReachProbe } from './reach-probes'")
    expect(companion).toContain("import { homeJump } from './home-jump'")
    const home = companion.slice(companion.indexOf('const comeHome = async'))
    expect(home).toContain('await tellTheDesktop({ ...report, probes })')
    expect(home.indexOf('await tellTheDesktop({ ...report, probes })')).toBeLessThan(home.indexOf('homeJump({'))
    expect(home).toContain('window.location.assign(url)')
    // Exactly one automatic navigation in the whole companion, and it is this one.
    expect(companion.split('location.assign(').length - 1).toBe(1)
  })

  it('the Mac answers the socket hello behind the Host gate and the pixel above the pairing gate', () => {
    const upgrade = server.slice(server.indexOf('export function handleUpgrade('))
    expect(upgrade.indexOf('refuseMisdirectedUpgrade(')).toBeLessThan(upgrade.indexOf('answerSocketHello('))
    expect(upgrade.indexOf('answerSocketHello(')).toBeLessThan(upgrade.indexOf('deps.onUpgrade?.('))
    expect(server.indexOf("url.pathname === PIXEL_PATH")).toBeLessThan(server.indexOf('await handleIdentityRoutes('))
  })
})
