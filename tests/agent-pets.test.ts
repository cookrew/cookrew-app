// THE PETS (renderer pets/): the agents, and the browsers and notes, as small
// round faces over every page, with the canvas and the stage's side columns
// retired (2026-10-30). Which ride along, in what order, and where a troop and
// a card may sit are pure rules, pinned here; the wiring by its source.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AgentRow } from '../src/renderer/src/agent-rows'
import {
  PET_DONE_FRESH_MS,
  PET_MAX,
  PET_MAX_PHONE,
  PET_MIN,
  cardPlacement,
  clampSpot,
  moodOf,
  petHome,
  petClick,
  petMax,
  pickItems,
  pickPets,
  readSpot
} from '../src/renderer/src/pets/pet-pick'
import { THUMB_WANTS_MAX, thumbWants } from '../src/renderer/src/pets/thumb-wants'

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

describe('which browsers and notes ride along', () => {
  const items = [
    { id: 'n-new', kind: 'note' as const },
    { id: 'b-mine', kind: 'browser' as const },
    { id: 'b-busy', kind: 'browser' as const },
    { id: 'n-old', kind: 'note' as const }
  ]
  const owners = new Map([
    ['b-mine', ['agent-on-stage']],
    ['b-busy', ['agent-busy']]
  ])

  it("the agent on stage's first, then the busy agents', then the newest", () => {
    const picked = pickItems(items, { owners, focus: ['agent-on-stage', 'agent-busy'], max: 3 })
    expect(picked.shown.map((item) => item.id)).toEqual(['b-mine', 'b-busy', 'n-new'])
    expect(picked.more.map((item) => item.id)).toEqual(['n-old'])
  })

  it('with nobody in focus, simply the newest', () => {
    expect(pickItems(items, { owners, focus: [] }).shown.map((item) => item.id)).toEqual(['n-new', 'b-mine', 'b-busy', 'n-old'])
  })

  it('a phone shows fewer of each, so both troops fit one row', () => {
    expect(petMax(412)).toBe(PET_MAX_PHONE)
    expect(petMax(1440)).toBe(PET_MAX)
  })

  it('asks for pictures of the faces it shows, never of a whole expanded troop', () => {
    thumbWants.set(Array.from({ length: 40 }, (_, n) => `b${n}`))
    expect(thumbWants.ids()).toHaveLength(THUMB_WANTS_MAX)
    thumbWants.set([])
  })
})

describe('where a troop sits', () => {
  it('is kept on screen however far it is dragged', () => {
    const troop = { width: 300, height: 50 }
    const view = { width: 1000, height: 800 }
    expect(clampSpot({ x: -50, bottom: 9999 }, troop, view)).toEqual({ x: 4, bottom: 746 })
    expect(clampSpot({ x: 900, bottom: -3 }, troop, view)).toEqual({ x: 696, bottom: 4 })
  })

  it('remembers a spot it was dragged to, and nothing that is not one', () => {
    expect(readSpot(null)).toBeNull()
    expect(readSpot('{"right":30,"bottom":40}')).toBeNull()
    expect(readSpot('not json')).toBeNull()
    expect(readSpot('{"x":30,"bottom":40}')).toEqual({ x: 30, bottom: 40 })
  })

  it("is home on the stage's bed, wherever the stage ends", () => {
    expect(petHome(56)).toEqual({ x: 8, bottom: 63 })
    expect(petHome(0)).toEqual({ x: 8, bottom: 7 })
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

// THE OWNER'S SKETCH (2026-10-31): hover names it, a click opens its card
// (the synopsis and a prompt box), a second click opens it in full.
describe('three steps to an agent', () => {
  it('the first click opens its card; the second, with its card open, opens it in full', () => {
    expect(petClick(null, 'a')).toBe('card')
    expect(petClick('a', 'a')).toBe('full')
    // Another face's card open: this one's card, not a jump into it.
    expect(petClick('b', 'a')).toBe('card')
  })

  it('hover names the face and opens nothing; no timer opens a card', () => {
    const troop = readFileSync('src/renderer/src/pets/PetTroop.tsx', 'utf8')
    expect(troop).toContain('setHoverId(member.id)')
    expect(troop).toContain('<span className="cr-pet-name" aria-hidden="true">')
    expect(troop).not.toMatch(/ENTER_MS|LEAVE_MS|setTimeout\(\(\) => setOpenId/)
    expect(troop).toContain("if (petClick(openId, id) === 'full')")
  })
})

describe('the wiring', () => {
  const agents = readFileSync('src/renderer/src/pets/AgentPets.tsx', 'utf8')
  const items = readFileSync('src/renderer/src/pets/ItemPets.tsx', 'utf8')
  const troop = readFileSync('src/renderer/src/pets/PetTroop.tsx', 'utf8')
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const css = readFileSync('src/renderer/src/pets/pets.css', 'utf8')

  it('both troops ride over every page: mounted in App, portalled to the body, under the scrims', () => {
    expect(app).toContain('<AgentPets workspace={workspace} workspaceId={activeWsId} onOpen={zoomToNode} />')
    expect(app).toContain('<ItemPets')
    expect(troop).toContain('document.body')
    expect(css).toMatch(/\.cr-pets \{[^}]*z-index: 55;/)
  })

  it('prompts the way the voice bar does: the words, then Enter on its own', () => {
    expect(agents).toMatch(/ptyInput\(row\.id, text\)\s+cookrew\(\)\.ptyInput\(row\.id, '\\r'\)/)
  })

  it('reads a tail only for the card that is open, never the whole board', () => {
    expect(agents).toContain('useStreamTails(useMemo(() => (live ? [] : [row.id]), [live, row.id]))')
    expect(agents).not.toContain('useCrewRows')
  })

  it("a browser's face is its page's picture, and the producers are fed from the faces", () => {
    expect(items).toContain('<img className="cr-pet-thumb" src={thumb}')
    expect(items).toContain('thumbWants.set(')
    expect(app.match(/thumbWants\.ids\(\)/g)).toHaveLength(2)
  })
})

describe('the canvas and the side columns are retired', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  const stage = readFileSync('src/renderer/src/stage/StageView.tsx', 'utf8')
  const header = readFileSync('src/renderer/src/Header.tsx', 'utf8')

  it('the canvas is not rendered, nor its overlay layer: it costs no CPU or GPU', () => {
    expect(app).not.toMatch(/<ReactFlow[\s>]/)
    expect(app).not.toMatch(/<LodOverlays[\s>]/)
    expect(header).toContain("export type MainView = 'stage' | 'levels' | 'agents'")
  })

  it('every card opens on the stage, wherever it was asked for from', () => {
    expect(app).toMatch(/const zoomToNode = useCallback\([\s\S]{0,1200}stageSelect\.set\([\s\S]{0,200}if \(viewRef\.current !== 'stage'\) setView\('stage'\)/)
  })

  it('the stage is one card wide, with a bed for the pets', () => {
    expect(stage).not.toMatch(/AgentColumn|ItemColumn/)
    expect(stage).toContain('cr-stage-view bedded')
  })
})
