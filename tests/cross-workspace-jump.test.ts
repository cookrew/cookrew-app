import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripComments } from './support/module-imports'
import {
  JUMP_WAIT_MS,
  createJumpController,
  type JumpMiss
} from '../src/renderer/src/cross-workspace-jump'

/**
 * TAPPING A BOARD ROW THAT LIVES IN ANOTHER WORKSPACE.
 *
 * The board lists every agent on the machine, across every workspace, and a tap
 * has always meant "take me to that card". For a row on the loaded canvas that
 * is one zoom. For a row anywhere else it was NOTHING: the card is not in the
 * flow store, so the zoom found no bounds, reported the miss (zoom-target.ts)
 * and left the viewport alone — the board closed and the owner was looking at
 * the workspace they started in, with no hint that the tap had been heard.
 *
 * So the tap now has a middle: switch, wait for the incoming canvas, zoom. The
 * WAITING is the whole difficulty, and it is what this file pins. The canvas
 * arrives on a broadcast the tap cannot await; it can arrive without the card
 * (the agent was dismissed between the roster read and the switch); it can
 * arrive after the owner has already tapped something else; and it can never
 * arrive at all.
 */

interface Card {
  readonly id: string
  readonly name: string
}

const card = (id: string): Card => ({ id, name: id.toUpperCase() })

/** A controller with every effect recorded and the clock in the test's hand. */
function harness(startingIn: string | null = 'w-here') {
  const switched: string[] = []
  const arrived: string[] = []
  /** Whether each arrival carried its node, or told the caller to look it up. */
  const carried: (string | null)[] = []
  const misses: JumpMiss[] = []
  /** Timers still armed, by id — cancelling forgets one rather than flagging it. */
  const armed = new Map<number, () => void>()
  const waits: number[] = []
  let nextTimer = 0
  let active = startingIn
  let refuse: Error | null = null
  /** How many times the jump gave the switch's own arrival back. */
  let handedBack = 0
  /** The cards on the canvas right now, whatever the roster claims. */
  const onCanvas = new Set<string>()

  const jump = createJumpController<Card>({
    activeWorkspaceId: () => active,
    hasNode: (nodeId) => onCanvas.has(nodeId),
    switchWorkspace: (id) => {
      switched.push(id)
      return refuse ? Promise.reject(refuse) : Promise.resolve()
    },
    arrive: (nodeId, node) => {
      arrived.push(nodeId)
      carried.push(node === null ? null : node.name)
    },
    handBack: () => void (handedBack += 1),
    schedule: (run, ms) => {
      const id = (nextTimer += 1)
      armed.set(id, run)
      waits.push(ms)
      return () => void armed.delete(id)
    },
    report: (miss) => void misses.push(miss)
  })

  return {
    jump,
    switched,
    arrived,
    carried,
    misses,
    handedBack: () => handedBack,
    /** The switch lands: the store's new activeId, then its new canvas. */
    landsOn: (id: string, nodes: readonly Card[]): void => {
      active = id
      onCanvas.clear()
      for (const node of nodes) onCanvas.add(node.id)
      jump.sawNodes(nodes)
    },
    /** Put a card on the canvas without a switch — a roster row that is here. */
    alreadyHere: (id: string): void => void onCanvas.add(id),
    refuseSwitch: (why: string): void => void (refuse = new Error(why)),
    /** Fire whatever give-up timer is still armed, as the browser would. */
    runWait: (): void => {
      const due = [...armed.values()]
      armed.clear()
      for (const run of due) run()
    },
    /** Every wait ever asked for, armed or since cancelled. */
    waits: (): readonly number[] => [...waits],
    armed: (): number => armed.size
  }
}

describe('a row on the canvas that is already loaded', () => {
  it('zooms straight to the card and switches nothing', () => {
    const h = harness('w-here')
    h.jump.to('w-here', 'agent-1')
    expect(h.switched).toEqual([])
    expect(h.arrived).toEqual(['agent-1'])
    // No node handed over: it is already in the flow store, and resolving it
    // there is what every card tap has always done.
    expect(h.carried).toEqual([null])
    expect(h.jump.travelling()).toBe(false)
  })

  it('zooms a card that IS on this canvas, whatever workspace the row claims', () => {
    // The roster is a claim made when it was read, and the flow store is the
    // truth. The demo bridge labels every row `active`, a real roster can be a
    // switch behind, and either way switching to a workspace whose card is
    // already in front of us would be a round trip to the same place — or, for
    // an id that does not resolve, a refusal where a zoom was owed.
    const h = harness('w-here')
    h.alreadyHere('agent-1')
    h.jump.to('active', 'agent-1')
    expect(h.switched).toEqual([])
    expect(h.arrived).toEqual(['agent-1'])
  })

  it('zooms when the active workspace is not known yet, rather than travelling', () => {
    // Before the first workspace:list lands there is no id to compare against.
    // Zooming is what the board did for every row before this existed, and it
    // is the answer that cannot strand anyone: a card that is here opens, and
    // one that is not reports its own miss, exactly as before.
    const h = harness(null)
    h.jump.to('w-somewhere', 'agent-1')
    expect(h.switched).toEqual([])
    expect(h.arrived).toEqual(['agent-1'])
  })
})

describe('a row that lives in another workspace', () => {
  it('asks for the switch and zooms nothing yet — the card is not here', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    expect(h.switched).toEqual(['w-there'])
    expect(h.arrived).toEqual([])
    expect(h.jump.travelling()).toBe(true)
  })

  it('zooms once the incoming canvas carries the card', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.landsOn('w-there', [card('agent-3'), card('agent-9')])
    expect(h.arrived).toEqual(['agent-9'])
    // The node travels with the landing. The canvas was handed to us this
    // instant, so the card's own box is the dependable one — asking a store
    // that has only just been given these nodes is the race we are avoiding.
    expect(h.carried).toEqual(['AGENT-9'])
    expect(h.jump.travelling()).toBe(false)
  })

  it('zooms EXACTLY once, however many broadcasts the switch fires', () => {
    // A switch is two broadcasts and a canvas edits itself afterwards; a jump
    // that re-fired on each would fight the owner's own panning.
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.landsOn('w-there', [card('agent-9')])
    h.jump.sawNodes([card('agent-9')])
    h.jump.sawNodes([card('agent-9'), card('agent-4')])
    expect(h.arrived).toEqual(['agent-9'])
  })

  it('keeps waiting when a canvas arrives without the card', () => {
    // The outgoing workspace's own last broadcast can land after the switch is
    // asked for; it is a canvas, and it is not the one the jump is for.
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.jump.sawNodes([card('agent-1'), card('agent-2')])
    expect(h.arrived).toEqual([])
    expect(h.jump.travelling()).toBe(true)
  })

  it('ignores a second tap on the same row instead of re-switching', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.jump.to('w-there', 'agent-9')
    expect(h.switched).toEqual(['w-there'])
    expect(h.waits()).toEqual([JUMP_WAIT_MS])
  })
})

describe('the arrival a plain switch would have done', () => {
  it('is withheld while the jump is travelling — the card is the destination', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    expect(h.jump.travelling()).toBe(true)
    expect(h.handedBack()).toBe(0)
  })

  it('is never spent when the jump lands', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.landsOn('w-there', [card('agent-9')])
    expect(h.handedBack()).toBe(0)
    expect(h.armed()).toBe(0)
  })

  it('is handed back when the wait runs out with no card', () => {
    // The agent was dismissed, or the switch stalled. Framing the workspace we
    // did arrive in beats holding the outgoing viewport over it forever.
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.runWait()
    expect(h.handedBack()).toBe(1)
    expect(h.jump.travelling()).toBe(false)
    expect(h.misses).toEqual([{ workspaceId: 'w-there', nodeId: 'agent-9', why: 'never-arrived' }])
  })

  it('does not zoom to a card that arrives after the wait ran out', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.runWait()
    h.landsOn('w-there', [card('agent-9')])
    expect(h.arrived).toEqual([])
  })
})

describe('a switch the app refuses', () => {
  it('drops the jump, says so, and moves no viewport at all', async () => {
    const h = harness('w-here')
    h.refuseSwitch('Workspace not found')
    h.jump.to('w-gone', 'agent-9')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.jump.travelling()).toBe(false)
    expect(h.armed()).toBe(0)
    // Nothing moved: we are still on the canvas the owner was looking at, and
    // its viewport is already the right one.
    expect(h.handedBack()).toBe(0)
    expect(h.misses).toEqual([{ workspaceId: 'w-gone', nodeId: 'agent-9', why: 'refused' }])
  })
})

describe('a second tap while the first is still travelling', () => {
  it('replaces the first, and the first card arriving does not hijack the view', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.jump.to('w-other', 'agent-4')
    expect(h.switched).toEqual(['w-there', 'w-other'])
    h.landsOn('w-there', [card('agent-9')])
    expect(h.arrived).toEqual([])
    h.landsOn('w-other', [card('agent-4')])
    expect(h.arrived).toEqual(['agent-4'])
  })

  it('disarms the first wait, so the abandoned jump cannot claim the fit', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.jump.to('w-other', 'agent-4')
    h.landsOn('w-other', [card('agent-4')])
    h.runWait()
    expect(h.handedBack()).toBe(0)
    expect(h.misses).toEqual([])
  })

  it('a tap on a row in the workspace we are travelling to still zooms there', () => {
    // The switch completed, the canvas is here, and the owner taps a second row
    // on it: that is an ordinary zoom, and it must cancel the stale wait.
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.landsOn('w-there', [card('agent-9')])
    h.jump.to('w-there', 'agent-3')
    expect(h.switched).toEqual(['w-there'])
    expect(h.arrived).toEqual(['agent-9', 'agent-3'])
  })
})

/**
 * WHOSE SWITCH IS THIS — the half that made the whole feature look broken.
 *
 * The canvas learns a switch happened twice, from two broadcasts the store
 * sends back to back: the new activeId, then the new nodes. On that second one
 * the jump lands and zooms. On the FIRST one, App resets everything a tap owns
 * — the fit is armed for the overview, the zoomed node id and the auto-open
 * credential are cleared, because ordinarily a switch is somebody arriving at
 * a workspace, not at a card.
 *
 * Ordinarily those arrive in that order and the reset happens before the zoom.
 * When they do not — and nothing in a transport, a batch of React updates or an
 * SSE flush promises they will not — the reset lands AFTER the zoom and undoes
 * it: no arrival, so no full view; no deliberate flag, so the phone's LOD
 * refuses to open the card; and an armed fit left over that the next node
 * change (constant, with ninety agents) spends on the overview, throwing the
 * viewport off the card that was just framed.
 *
 * So the switch has to be attributable. A jump that ASKED for a workspace
 * claims the arrival at it, exactly once, and the reset stands down.
 */
describe('a switch a jump asked for', () => {
  it('is claimed by the jump, so the canvas leaves the tap state alone', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    expect(h.jump.claims('w-there')).toBe(true)
  })

  it('is claimed exactly once — a later arrival at the same workspace is not ours', () => {
    // The owner switching back by hand afterwards is an ordinary switch, and
    // must get the ordinary overview fit.
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    expect(h.jump.claims('w-there')).toBe(true)
    expect(h.jump.claims('w-there')).toBe(false)
  })

  it('is still claimed when the canvas beat the list here — the order that broke it', () => {
    // The nodes arrived first, so the jump has already landed and zoomed by
    // the time the id shows up. This is precisely when the reset would undo a
    // zoom that had already happened.
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.landsOn('w-there', [card('agent-9')])
    expect(h.arrived).toEqual(['agent-9'])
    expect(h.jump.claims('w-there')).toBe(true)
  })

  it('claims nothing for a workspace nobody jumped to', () => {
    const h = harness('w-here')
    expect(h.jump.claims('w-elsewhere')).toBe(false)
    h.jump.to('w-there', 'agent-9')
    expect(h.jump.claims('w-elsewhere')).toBe(false)
  })

  it('claims nothing after the wait ran out — that fit is owed again', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.runWait()
    expect(h.jump.claims('w-there')).toBe(false)
  })

  it('claims nothing for a zoom that never left this canvas', () => {
    const h = harness('w-here')
    h.jump.to('w-here', 'agent-1')
    expect(h.jump.claims('w-here')).toBe(false)
  })

  it('claims nothing once the jump is cancelled', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.jump.cancel()
    expect(h.jump.claims('w-there')).toBe(false)
  })
})

/**
 * WHAT THE TAP GETS BACK. The board closed the instant a row was tapped, which
 * for a row on another workspace meant handing the owner the canvas they were
 * already looking at and asking them to believe something was happening. The
 * switch itself is 36-237ms of bookkeeping (measured, dev event log) but the
 * PTYs boot for seconds afterwards, so "nothing visibly happened" is a long
 * moment. The tap now answers, so the board can hold itself open and say which
 * row it is opening — and say so when it fails, which a console warning on a
 * phone does not.
 */
describe('the answer a tap gets', () => {
  it('says `here` for a card on this canvas, resolved without waiting on anything', async () => {
    const h = harness('w-here')
    await expect(h.jump.to('w-here', 'agent-1')).resolves.toBe('here')
  })

  it('says `landed` only when the card is actually framed', async () => {
    const h = harness('w-here')
    const travel = h.jump.to('w-there', 'agent-9')
    h.landsOn('w-there', [card('agent-9')])
    await expect(travel).resolves.toBe('landed')
  })

  it('says `missed` when the wait runs out', async () => {
    const h = harness('w-here')
    const travel = h.jump.to('w-there', 'agent-9')
    h.runWait()
    await expect(travel).resolves.toBe('missed')
  })

  it('says `missed` when the switch is refused', async () => {
    const h = harness('w-here')
    h.refuseSwitch('Workspace not found')
    await expect(h.jump.to('w-gone', 'agent-9')).resolves.toBe('missed')
  })

  it('answers an abandoned jump rather than leaving the board waiting forever', async () => {
    const h = harness('w-here')
    const first = h.jump.to('w-there', 'agent-9')
    h.jump.to('w-other', 'agent-4')
    await expect(first).resolves.toBe('missed')
  })

  it('answers a cancelled jump too', async () => {
    const h = harness('w-here')
    const travel = h.jump.to('w-there', 'agent-9')
    h.jump.cancel()
    await expect(travel).resolves.toBe('missed')
  })
})

describe('leaving the canvas', () => {
  it('cancels a jump in flight so nothing zooms after unmount', () => {
    const h = harness('w-here')
    h.jump.to('w-there', 'agent-9')
    h.jump.cancel()
    expect(h.jump.travelling()).toBe(false)
    expect(h.armed()).toBe(0)
    h.landsOn('w-there', [card('agent-9')])
    expect(h.arrived).toEqual([])
    expect(h.handedBack()).toBe(0)
  })
})

/**
 * A SOURCE PROXY for the three rules that live in App and can live nowhere
 * else — they are reads and writes of refs inside one component, and the
 * defect they fix was invisible for exactly that reason. What the source can
 * honestly say is that the canvas ASKS, rather than resetting regardless.
 */
describe('the canvas asks whose switch it is', () => {
  // Comments stripped first: these are assertions about what the code does,
  // and this file's own prose must not be able to satisfy them.
  const app = stripComments(
    readFileSync(join(__dirname, '../src/renderer/src/App.tsx'), 'utf8')
  ).replace(/\s+/g, ' ')

  it('lets a jump that claimed the arrival keep the tap state it is about to set', () => {
    expect(app).toContain('if (jumpRef.current?.claims(id) === true) return')
  })

  it('withholds the overview fit while a jump is still travelling', () => {
    expect(app).toContain('if (jumpRef.current?.travelling() === true) return')
  })

  it('hands the whole arrival back — not just the fit — when the jump gives up', () => {
    const from = app.indexOf('handBack: () => {')
    expect(from, 'handBack is wired').toBeGreaterThan(-1)
    const handBack = app.slice(from, app.indexOf('schedule:', from))
    // Everything the workspace reset would have done, since that is precisely
    // what was withheld while the jump held the claim.
    expect(handBack).toContain('zoomedNodeIdRef.current = null')
    expect(handBack).toContain('deliberateOpenRef.current = false')
    expect(handBack).toContain('setArrivedId(null)')
    expect(handBack).toContain('fitAll(')
  })
})
