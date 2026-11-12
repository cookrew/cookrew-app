import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BAR_ROOM, DevicesCanvas, canvasOf, type CanvasMachine } from '../src/renderer/src/zoom/DevicesCanvas'
import type { MachineView } from '../src/renderer/src/zoom/zoom-model'
import { canvasMachineOf } from '../src/renderer/src/console/ConsoleDevicesView'
import type { ConsoleMachine } from '../src/renderer/src/console/console-devices'

/**
 * THE CONSOLE'S DEVICES LEVEL HAS NO MACHINE ENTERED (owner 2026-11-12): every
 * machine a peer, one frame size, the same whichever was entered before.
 */

const view = (id: string, name: string, workspaces: number): MachineView => ({
  id, name, local: false, online: true, detail: 'live', os: 'linux',
  workspaces: [], agents: workspaces, waiting: 0,
  marks: Array.from({ length: workspaces }, (_, i) => ({ id: `${id}-w${i}`, name: `W${i}`, presets: ['claude'], waiting: false, waitingCount: 0, browsers: 1, notes: 0, deck: [] }))
})

describe('canvasOf', () => {
  it('one frame for every machine, the first at the origin, the others in its row', () => {
    const two = canvasOf(2, false, 1440, 900)
    expect(two.at[0]).toEqual({ x: 0, y: 0 })
    expect(two.at[1]!.y).toBe(0)
    expect(two.at[1]!.x).toBeGreaterThan(two.frame.w)
    expect(canvasOf(5, false, 1440, 900).frame).toEqual(two.frame)
  })

  it('framed inside the view, above the bar', () => {
    const p = canvasOf(3, false, 1440, 900)
    expect(p.s).toBeGreaterThan(0)
    expect(p.s).toBeLessThanOrEqual(1)
    // The first frame's top-left and the last's right edge stay on screen.
    expect(p.x + p.s * (p.at[0]!.x - p.frame.w / 2)).toBeGreaterThan(0)
    expect(p.x + p.s * (p.at[2]!.x + p.frame.w / 2)).toBeLessThan(1440)
    expect(p.y + p.s * (p.at[0]!.y + p.frame.h / 2)).toBeLessThan(900 - BAR_ROOM)
  })

  it('a phone stacks them, one a row', () => {
    const p = canvasOf(2, true, 412, 915)
    expect(p.at.map((a) => a.x)).toEqual([0, 0])
    expect(p.at[1]!.y).toBeGreaterThan(p.frame.h)
  })
})

describe('DevicesCanvas', () => {
  it('draws every machine the same way, and says it stands at the devices', () => {
    const machines: CanvasMachine[] = [
      { view: view('a', 'MacBook Pro', 9), say: null, caption: '9 workspaces', standing: 'live', openable: true },
      { view: view('b', 'Solis-Core', 1), say: null, caption: '1 workspace', standing: 'live', openable: true },
      { view: { ...view('c', 'Studio', 0), online: false }, say: 'Open Cookrew on Studio.', caption: 'Open Cookrew on Studio.', standing: 'offline', openable: false }
    ]
    const html = renderToStaticMarkup(<DevicesCanvas machines={machines} onEnter={() => undefined} />)
    expect(html.match(/class="zv-machine zv-other/g)).toHaveLength(3)
    expect(html).toContain('MacBook Pro')
    expect(html).toContain('Solis-Core')
    expect(html).toContain('Open Cookrew on Studio.')
    expect(html).toMatch(/aria-current="step" aria-label="devices"/)
    // Each frame the same size.
    expect(new Set(html.match(/width:\d+(\.\d+)?px;height:\d+(\.\d+)?px/g)).size).toBe(1)
  })

  const render = (machines: CanvasMachine[], openingId: string | null = null, gaugeOf?: (m: MachineView) => React.ReactNode): string =>
    renderToStaticMarkup(<DevicesCanvas machines={machines} openingId={openingId} gaugeOf={gaugeOf} onEnter={() => undefined} />)
  const lit = (id: string, name: string): CanvasMachine => ({ view: view(id, name, 2), say: null, caption: '2 workspaces', standing: 'live', openable: true })

  it('a machine that cannot be gone into is no control, and says where it stands', () => {
    const html = render([lit('a', 'Studio Mac'), { view: view('c', 'Attic Mac', 0), say: 'Update Cookrew on Attic Mac.', caption: 'Mac · online', standing: 'outdated', openable: false }])
    expect(html).toMatch(/class="dc-machine" data-standing="live"/)
    expect(html).toMatch(/class="dc-machine" data-standing="outdated"/)
    expect(html).toMatch(/aria-label="Open Studio Mac"(?![^>]*disabled)/)
    expect(html).toMatch(/aria-label="Attic Mac: Update Cookrew on Attic Mac\."[^>]*disabled=""/)
  })

  it('a gauge only on a machine whose screen is lit', () => {
    const asked: string[] = []
    const html = render([lit('a', 'Studio Mac'), { view: view('c', 'Road Laptop', 3), say: 'Prove it’s you to see inside.', caption: 'Mac · online', standing: 'locked', openable: true }], null, (m) => {
      asked.push(m.id)
      return <i className="probe-gauge" />
    })
    expect(asked).toEqual(['a'])
    expect(html.match(/probe-gauge/g)).toHaveLength(1)
  })

  it('with no machine to read, the bar goes nowhere', () => {
    const html = render([{ view: view('c', 'Road Laptop', 0), say: 'Prove it’s you to see inside.', caption: '', standing: 'locked', openable: true }])
    expect(html).toMatch(/aria-label="workspaces" disabled=""/)
    expect(html).toMatch(/aria-label="artifacts" disabled=""/)
    expect(html).toMatch(/aria-label="agents" disabled=""/)
    expect(render([lit('a', 'Studio Mac')])).not.toMatch(/aria-label="workspaces" disabled=""/)
  })

  it('while one opens, it is marked, the rest step back, and nothing more can be pressed', () => {
    const html = render([lit('a', 'Studio Mac'), lit('b', 'Solis-Core')], 'b')
    expect(html).toMatch(/data-testid="devices-canvas" data-opening="true"/)
    expect(html).toMatch(/data-standing="live" data-opening="true"/)
    expect(html.match(/data-opening="true"/g)).toHaveLength(2)
    expect(html).toMatch(/aria-label="Open Studio Mac"[^>]*disabled=""/)
    expect(html).toMatch(/aria-label="workspaces" disabled=""/)
  })
})

/**
 * NOTHING OF A MACHINE BEFORE THE GATE: its name, platform and line, no
 * workspace, count, path or picture (console-devices.ts · compose drops them;
 * this draws none even were one there).
 */
describe('the console\'s canvas machine', () => {
  const machine = (standing: ConsoleMachine['standing'], over: Partial<ConsoleMachine> = {}): ConsoleMachine => ({
    id: 'm', name: 'Studio Mac', os: 'darwin', online: true, lastSeenAt: null, standing, say: null,
    workspaces: [{ id: 'w', name: 'Secret Plans', icon: null, agents: 2, waiting: 1, working: 0 }],
    counts: { agents: 2, waiting: 1, working: 0, browsers: 1, notes: 0 },
    view: view('m', 'Studio Mac', 1),
    ...over
  })

  it('before the gate: a blank screen that asks for proof, no tiles, no path, but it can still be opened', () => {
    const one = canvasMachineOf(machine('locked'), 'LAN')
    expect(one.say).toBe('Prove it’s you to see inside.')
    expect(one.view.marks).toEqual([])
    expect(one.badge).toBeNull()
    expect(one.openable).toBe(true)
    const html = renderToStaticMarkup(<DevicesCanvas machines={[one]} onEnter={() => undefined} />)
    expect(html).not.toContain('zv-om-tile')
    expect(html).not.toContain('Secret Plans')
  })

  it('being read: its frame waits, still blank', () => {
    const one = canvasMachineOf(machine('reading'), 'RELAY')
    expect(one.say).toBe('…')
    expect(one.view.marks).toEqual([])
  })

  it('read: its own tiles, and the path it is reached by, explained', () => {
    const one = canvasMachineOf(machine('live'), 'RELAY')
    expect(one.say).toBeNull()
    expect(one.view.marks.map((m) => m.id)).toEqual(['m-w0'])
    const html = renderToStaticMarkup(<>{one.badge}</>)
    expect(html).toContain('data-path="RELAY"')
    expect(html).toContain('title="Reached through the Cookrew relay"')
  })

  it('offline or outdated: no control, and the one thing to do', () => {
    const off = canvasMachineOf(machine('offline', { online: false, say: 'Open Cookrew on Studio Mac.' }), 'LAN')
    expect(off).toMatchObject({ openable: false, say: 'Open Cookrew on Studio Mac.', badge: null })
    expect(canvasMachineOf(machine('outdated', { say: 'Update Cookrew on Studio Mac.' }), 'LAN').openable).toBe(false)
    expect(canvasMachineOf(machine('blocked', { say: 'x' }), 'LAN').openable).toBe(false)
  })
})
