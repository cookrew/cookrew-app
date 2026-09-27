import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkspaceWall } from '../src/renderer/src/WorkspaceWall'
import type { Snapshot, WorkspaceFace } from '../src/renderer/src/workspace-wall-store'
import type { WorkspaceMap } from '../src/shared/workspace-map'

/**
 * THE WALL PAINTS — the cheap half of "it is on the card".
 *
 * A static render runs the component body and every branch reachable without
 * effects, and because the markup IS the picture, the picture can be asserted:
 * the snapshots are there as images, the picked screen is square on and
 * labelled, the age of each picture is stamped, and a workspace that has never
 * been photographed says so rather than showing a broken frame.
 */

const WS: WorkspaceFace[] = [
  { id: 'w1', name: 'Cookrew Dev', icon: '📁', dir: '~/workspace/cookrew-dev' },
  { id: 'w2', name: 'Lab', icon: '🧪', dir: '~/workspace/lab' },
  { id: 'w3', name: 'Voice', icon: '🌏', dir: '~/workspace/voice-gateway' },
]
const NOW = 1_790_000_000_000
const STAGE = { left: 0, top: 56, width: 1200, height: 800 }
const SHOTS: Record<string, Snapshot> = {
  w1: { src: 'data:image/jpeg;base64,AAAA', at: NOW - 90_000 },
  w2: { src: 'data:image/jpeg;base64,BBBB', at: NOW - 5 * 3_600_000 },
}

/** The live workspace's own shape, which needs no camera (workspace-map.ts). */
const MAP: WorkspaceMap = {
  width: 1000,
  height: 600,
  cells: [
    { x: 0, y: 0, w: 120, h: 80, kind: 'terminal' },
    { x: 300, y: 200, w: 120, h: 80, kind: 'note' },
    { x: 700, y: 400, w: 200, h: 140, kind: 'browser' },
  ],
}

const wall = (over: Partial<React.ComponentProps<typeof WorkspaceWall>> = {}): string =>
  renderToStaticMarkup(
    <WorkspaceWall
      open
      workspaces={WS}
      activeId="w1"
      recent={['w1', 'w2', 'w3']}
      shots={SHOTS}
      stage={STAGE}
      now={NOW}
      onEnter={() => undefined}
      onClose={() => undefined}
      onCreate={() => undefined}
      onDirectories={() => undefined}
      onRemove={() => undefined}
      {...over}
    />
  )

describe('the wall is a row of screens carrying canvases', () => {
  it('draws one screen per workspace, each with its snapshot, and one more for NEW', () => {
    const html = wall()
    expect((html.match(/cr-wsw-screen/g) ?? []).length).toBe(4)
    expect(html).toContain('data:image/jpeg;base64,AAAA')
    expect(html).toContain('data:image/jpeg;base64,BBBB')
  })

  it('names every workspace, with the directory under it', () => {
    const html = wall()
    for (const w of WS) {
      expect(html, w.name).toContain(w.name)
      expect(html, w.dir).toContain(w.dir)
    }
  })

  it('stamps how old each picture is — a snapshot must never pass for now', () => {
    const html = wall()
    expect(html).toContain('1m ago')
    expect(html).toContain('5h ago')
  })

  it('says so when a workspace has never been photographed', () => {
    // Never left, so never captured. A blank frame would read as a broken
    // image; a sentence reads as a fact.
    const html = wall()
    expect(html).toContain('NO SNAPSHOT YET')
    // …and it is stamped with no age, because there is nothing to date.
    expect((html.match(/cr-wsw-stamp/g) ?? []).length).toBe(2)
  })
})

describe('what the wall opens on', () => {
  /**
   * THE SCREEN YOU ARE STANDING IN. Its photograph is taken by Electron when
   * the wall opens, so the phone — which has no window to photograph and may
   * not fire a capture on the Mac — never had one, and the centre screen read
   * NO SNAPSHOT YET for the one workspace the reader was actually in. The
   * renderer holds that workspace's state, so the shape is drawn from it.
   */
  it('draws the live workspace’s own shape when no photograph exists', () => {
    const html = wall({ shots: {}, maps: { w1: MAP } })
    expect(html).toContain('cr-wsw-map')
    expect(html).toContain('viewBox="0 0 1000 600"')
    // One rectangle per node, each saying what it is so the drawing can
    // colour an agent differently from a note.
    expect((html.match(/data-kind=/g) ?? [])).toHaveLength(3)
    expect(html).toContain('data-kind="terminal"')
    // …and the screen no longer claims to have nothing.
    const screen = html.slice(html.indexOf('data-ws="w1"'), html.indexOf('data-ws="w2"'))
    expect(screen).not.toContain('NO SNAPSHOT YET')
  })

  it('prefers the photograph when there is one — the drawing is the fallback', () => {
    const html = wall({ maps: { w1: MAP } })
    const screen = html.slice(html.indexOf('data-ws="w1"'), html.indexOf('data-ws="w2"'))
    expect(screen).toContain('data:image/jpeg;base64,AAAA')
    expect(screen).not.toContain('cr-wsw-map')
  })

  it('still says so for a workspace with neither a photograph nor a shape', () => {
    const html = wall({ shots: {}, maps: {} })
    expect(html).toContain('NO SNAPSHOT YET')
    expect(html).not.toContain('cr-wsw-map')
  })

  it('draws a shape and nothing else — no names, no note bodies', () => {
    const html = wall({ shots: {}, maps: { w1: MAP } })
    const svg = html.slice(html.indexOf('cr-wsw-map'), html.indexOf('</svg>'))
    expect(svg).not.toContain('Cookrew Dev')
    expect(svg).not.toMatch(/<text/)
  })

  it('renders nothing at all when it is closed', () => {
    // Closed means GONE, not hidden: a wall left in the tree is three images
    // decoded for a surface nobody asked for.
    expect(wall({ open: false })).toBe('')
  })

  it('renders nothing when there is no workspace to show', () => {
    expect(wall({ workspaces: [] })).toBe('')
  })

  it('covers the stage it will hand back to', () => {
    const html = wall()
    expect(html).toContain('left:0')
    expect(html).toContain('top:56px')
    expect(html).toContain('width:1200px')
  })

  it('is a modal surface, and says which one', () => {
    const html = wall()
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-label="Switch workspace"')
  })

  it('offers the keys it answers to', () => {
    const html = wall()
    expect(html).toContain('PICK')
    expect(html).toContain('OPEN')
    expect(html).toContain('CANCEL')
  })
})

describe('the picked screen', () => {
  it('is square on and at the front, and the others are turned away', () => {
    const html = wall()
    expect(html).toContain('rotateY(0deg)')
    expect(html).toContain('rotateY(-34deg)')
  })

  it('carries the only visible label', () => {
    // Every screen has a label in the markup; CSS shows the picked one's. The
    // markup keeps them all so the label does not pop in on every step.
    expect((wall().match(/cr-wsw-label/g) ?? []).length).toBe(4)
    expect(wall()).toContain('cr-wsw-screen pick')
  })

  it('marks the live workspace, and it is NOT the picked one', () => {
    // The wall opens on the PREVIOUS workspace (openingPick): the one you are
    // already in is never the pre-selection, so these two are different
    // screens and both have to be legible.
    const html = wall({ activeId: 'w1' })
    expect(html).toContain('here now')
    expect(html).toContain('cr-wsw-screen live')
    expect(html).toContain('cr-wsw-screen pick')
    expect(html).not.toContain('cr-wsw-screen pick live')
  })

  it('opens on the previous workspace, so ENTER goes where you were', () => {
    // Pre-selecting where you already stand makes the first key a correction.
    const html = wall()
    const pickAt = html.indexOf('cr-wsw-screen pick')
    const liveAt = html.indexOf('cr-wsw-screen live')
    expect(liveAt).toBeGreaterThanOrEqual(0)
    expect(pickAt).toBeGreaterThan(liveAt)   // live is first in MRU, pick second
  })
})

describe('what it refuses to spend', () => {
  it('reflects the neighbours only, and only those with a picture', () => {
    // Under the picked screen that space belongs to the label; and a
    // reflection of nothing is a second decode for no pixels.
    const html = wall()
    expect((html.match(/cr-wsw-mirror/g) ?? []).length).toBe(1)
  })

  it('puts NO layer over the screens, so a tap reaches one (mobile)', () => {
    // The drag used to be its own absolutely-positioned surface. `.cr-wsw-track`
    // carries `transform-style:preserve-3d`, which establishes a stacking
    // context — so the screens' z-indexes are LOCAL to it and the track sits at
    // `auto`. One layer at z-index 1 therefore covered every screen, and
    // tapping one did nothing on any platform. The drag lives on the root now.
    const html = wall()
    expect(html).not.toContain('cr-wsw-swipe')
    // The screens are the only things between the wash and the reader.
    const layers = (html.match(/class="cr-wsw-[a-z]+"/g) ?? []).filter(
      (c) => !c.includes('track') && !c.includes('wash') && !c.includes('hud')
    )
    expect(layers.length).toBeGreaterThan(0)
  })

  it('lets a screen past the visible depth swallow no clicks', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...WS[0], id: `x${i}`, name: `WS ${i}` }))
    const html = renderToStaticMarkup(
      <WorkspaceWall
        open
        workspaces={many}
        activeId="x0"
        recent={[]}
        shots={{}}
        stage={STAGE}
        now={NOW}
        onEnter={() => undefined}
        onClose={() => undefined}
        onCreate={() => undefined}
        onDirectories={() => undefined}
        onRemove={() => undefined}
      />
    )
    expect(html).toContain('pointer-events:none')
    expect(html).toContain('opacity:0')
  })
})

describe('the dropdown’s jobs, on the wall', () => {
  it('ends the row with a NEW screen, so making a workspace is picking a picture too', () => {
    const html = wall()
    expect((html.match(/cr-wsw-screen/g) ?? []).length).toBe(4)
    expect(html).toContain('NEW WORKSPACE')
    expect(html.lastIndexOf('data-ws="__new__"')).toBeGreaterThan(html.lastIndexOf('data-ws="w3"'))
  })

  it('offers the picked workspace its actions: open, directories, remove, history', () => {
    const html = wall({ onActivity: () => undefined })
    expect(html).toContain('cr-wsw-actions')
    for (const word of ['OPEN', 'DIRECTORIES', 'REMOVE', 'HISTORY']) expect(html, word).toContain(word)
  })

  it('will not offer to remove the last workspace', () => {
    const html = wall({ workspaces: [WS[0]], recent: ['w1'], canRemove: false })
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*REMOVE/)
  })

  it('offers CREATE, and nothing to remove, on the NEW screen', () => {
    // A single workspace opens on itself; step once and NEW is the pick.
    const html = wall({ workspaces: [WS[0]], recent: ['w1'], initialPick: 1 })
    expect(html).toContain('CREATE')
    expect(html).not.toContain('>REMOVE')
  })

  it('opens the create sheet over the wall when asked to', () => {
    const html = wall({ initialSheet: 'create', teams: [] })
    expect(html).toContain('cr-wsw-sheet')
    expect(html).toContain('placeholder="workspace name"')
  })
})

describe('on a phone', () => {
  it('says swipe and tap, because there are no arrow keys', () => {
    const html = wall({ touch: true })
    expect(html).toContain('SWIPE')
    expect(html).toContain('TAP')
    expect(html).not.toContain('ESC')
  })

  it('still says the keys on a desk', () => {
    expect(wall({ touch: false })).toContain('ESC')
  })
})
