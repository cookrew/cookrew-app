// THE AGENTS AS PETS (renderer pets/): small round avatars over every page.
// Which agents ride along, in what order, and where the troop and a card may
// sit are pure rules, pinned here; the wiring is pinned by its source.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AgentRow } from '../src/renderer/src/agent-rows'
import {
  PET_DONE_FRESH_MS,
  PET_HOME,
  PET_HOME_PHONE,
  PET_MAX,
  PET_MIN,
  cardPlacement,
  clampSpot,
  moodOf,
  petHome,
  pickPets,
  readSpot
} from '../src/renderer/src/pets/pet-pick'

const NOW = 10_000_000
const row = (id: string, phase: AgentRow['phase'], ago: number, over: Partial<AgentRow> = {}): AgentRow => ({
  id,
  name: id,
  preset: 'claude',
  role: null,
  orch: false,
  active: true,
  workspaceId: 'ws',
  workspaceName: 'WS',
  cwd: '/',
  spawnedAt: 0,
  phase,
  turn: null,
  turnCount: 1,
  lastActivityAt: NOW - ago,
  ...over
})
const ids = (pets: readonly { row: AgentRow }[]): string[] => pets.map((pet) => pet.row.id)

describe('who rides along', () => {
  it('whoever needs you first, then whoever is working, then what finished lately', () => {
    const troop = pickPets(
      [row('done', 'done', 60_000), row('work', 'working', 5_000), row('need', 'waiting', 90_000), row('need2', 'waiting', 1_000)],
      { workspaceId: 'ws', now: NOW }
    )
    expect(ids(troop.pets)).toEqual(['need2', 'need', 'work', 'done'])
    expect(troop.pets.map((pet) => pet.mood)).toEqual(['needs', 'needs', 'working', 'done'])
  })

  it('a finished turn stops being news after a while', () => {
    expect(moodOf(row('a', 'done', PET_DONE_FRESH_MS - 1), NOW)).toBe('done')
    expect(moodOf(row('a', 'done', PET_DONE_FRESH_MS + 1), NOW)).toBeNull()
    expect(moodOf(row('a', 'waiting', 1, { active: false }), NOW)).toBeNull()
  })

  it('puts the rest behind the +N coin, in the same order', () => {
    const rows = Array.from({ length: PET_MAX + 3 }, (_, n) => row(`w${n}`, 'working', n * 1000))
    const troop = pickPets(rows, { workspaceId: 'ws', now: NOW })
    expect(troop.pets).toHaveLength(PET_MAX)
    expect(ids(troop.more)).toEqual(['w5', 'w6', 'w7'])
  })

  it('never leaves a quiet workspace without a troop: the latest sit in, asleep', () => {
    const troop = pickPets([row('old', 'done', 3 * 3600_000), row('older', 'quiet', 9 * 3600_000), row('oldest', 'offline', 99 * 3600_000), row('x', 'quiet', 999 * 3600_000)], {
      workspaceId: 'ws',
      now: NOW
    })
    expect(ids(troop.pets)).toEqual(['old', 'older', 'oldest'])
    expect(troop.pets.every((pet) => pet.mood === 'asleep')).toBe(true)
    expect(troop.pets).toHaveLength(PET_MIN)
    expect(ids(troop.more)).toEqual(['x'])
  })

  it('only the loaded workspace: its agents are the ones a prompt reaches', () => {
    const troop = pickPets([row('here', 'working', 1), row('there', 'waiting', 1, { workspaceId: 'other' })], { workspaceId: 'ws', now: NOW })
    expect(ids([...troop.pets, ...troop.more])).toEqual(['here'])
  })

  it('no agents, no troop', () => {
    expect(pickPets([], { workspaceId: 'ws', now: NOW }).pets).toEqual([])
  })
})

describe('where the troop sits', () => {
  it('is kept on screen however far it is dragged', () => {
    const troop = { width: 300, height: 50 }
    const view = { width: 1000, height: 800 }
    expect(clampSpot({ right: -50, bottom: 9999 }, troop, view)).toEqual({ right: 4, bottom: 746 })
    expect(clampSpot({ right: 900, bottom: -3 }, troop, view)).toEqual({ right: 696, bottom: 4 })
  })

  it('goes home when nothing, or nothing sensible, was saved', () => {
    expect(readSpot(null)).toEqual(PET_HOME)
    expect(readSpot('{"right":"x"}')).toEqual(PET_HOME)
    expect(readSpot('not json', PET_HOME_PHONE)).toEqual(PET_HOME_PHONE)
    expect(readSpot('{"right":30,"bottom":40}')).toEqual({ right: 30, bottom: 40 })
  })

  it('stands on the right edge of a phone, clear of the prompt line', () => {
    expect(petHome(412)).toBe(PET_HOME_PHONE)
    expect(petHome(1440)).toBe(PET_HOME)
  })
})

describe("where a pet's card opens", () => {
  const view = { width: 1000, height: 800 }
  const card = { width: 340, height: 200 }

  it('above the pet when it fits, centred and kept inside the screen', () => {
    const at = cardPlacement({ left: 950, top: 700, width: 38, height: 38 }, card, view)
    expect(at).toEqual({ left: 652, top: 490, above: true })
  })

  it('below the pet when the troop was dragged to the top', () => {
    const at = cardPlacement({ left: 10, top: 20, width: 38, height: 38 }, card, view)
    expect(at.above).toBe(false)
    expect(at.top).toBe(68)
    expect(at.left).toBe(8)
  })
})

describe('the wiring', () => {
  const pets = readFileSync('src/renderer/src/pets/AgentPets.tsx', 'utf8')
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')

  it('rides over every page: mounted once in App, portalled to the body, under the scrims', () => {
    expect(app).toContain('<AgentPets workspace={workspace} workspaceId={activeWsId} onOpen={(row) => void zoomToNode(row.id)} />')
    expect(pets).toContain('document.body')
    const css = readFileSync('src/renderer/src/pets/pets.css', 'utf8')
    expect(css).toMatch(/\.cr-pets \{[^}]*z-index: 55;/)
  })

  it('prompts the way the voice bar does: the words, then Enter on its own', () => {
    expect(pets).toMatch(/ptyInput\(row\.id, text\)\s+cookrew\(\)\.ptyInput\(row\.id, '\\r'\)/)
  })

  it('reads one tail, for the card that is open, never the whole board again', () => {
    expect(pets).toContain('useStreamTails(useMemo(() => (openId ? [openId] : []), [openId]))')
  })
})
