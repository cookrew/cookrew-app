import { describe, expect, it } from 'vitest'
import { desktopRows, LINKS_PER_ACCOUNT, presenceOf } from '../scripts/strata-mock-registry.mjs'
import { syntheticFleet } from '../src/strata/fixture/synthetic'

const NOW = 1_800_000_000_000
const AT = NOW + 60_000

describe('the strata preview registry mock', () => {
  const fleet = syntheticFleet(NOW)

  it('lists every machine at its preview base, without its levels', () => {
    const rows = desktopRows(fleet, AT)
    expect(rows.map((r) => r.id)).toEqual(fleet.map((m) => m.id))
    expect(rows.every((r) => r.base === `/m/${r.id}/` && !('levels' in r))).toBe(true)
  })

  it('answers presence for every machine, with the account cap and the online count', () => {
    const presence = presenceOf(fleet, AT)
    expect(presence.at).toBe(AT)
    expect(presence.cap).toBe(LINKS_PER_ACCOUNT)
    expect(presence.desktops.map((d) => d.id)).toEqual(fleet.map((m) => m.id))
    expect(presence.online).toBe(fleet.filter((m) => m.online).length)
  })

  it('gives a presence row exactly the meaning of its list row', () => {
    const rows = desktopRows(fleet, AT)
    expect(presenceOf(fleet, AT).desktops).toEqual(rows.map(({ id, online, lastSeenAt }) => ({ id, online, lastSeenAt })))
    expect(rows.filter((r) => r.online).every((r) => r.lastSeenAt === AT)).toBe(true)
  })

  it('keeps an offline machine’s own last sighting, null when it was never reached', () => {
    const offline = fleet.filter((m) => !m.online)
    const seen = new Map(presenceOf(fleet, AT).desktops.map((d) => [d.id, d.lastSeenAt]))
    expect(offline.length).toBeGreaterThan(0)
    expect(offline.every((m) => seen.get(m.id) === m.lastSeenAt)).toBe(true)
    expect(offline.some((m) => m.lastSeenAt === null)).toBe(true)
  })

  it('leaves the machines it reads untouched', () => {
    const before = structuredClone(fleet)
    desktopRows(fleet, AT)
    presenceOf(fleet, AT)
    expect(fleet).toEqual(before)
  })
})
