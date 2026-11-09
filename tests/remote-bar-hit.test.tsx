// THE BAR'S HIT AREA (RemotePanel.tsx · RemoteBarView in its band): it fills
// its band, every press, touch and wheel on it stays on it, and its height does
// not change when control is taken or given back, so the picture never moves.
import { isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FRAME_CONTROLS, RemoteBarView } from '../src/renderer/src/use/RemotePanel'
import { remoteBarControl } from '../src/renderer/src/use/UseOverlay'
import type { BarBand } from '../src/renderer/src/use/remote-layout'
import type { CardControl } from '../src/shared/remote-access'
import type { UseStatus } from '../src/shared/use-signal'

const watching: CardControl = { switchOn: true, until: null, heldBy: null, awake: true, machine: 'linux' }
const holding: CardControl = { ...watching, until: 1000 + 14 * 60_000 }
const row: BarBand = { place: 'row', rect: { left: 0, top: 0, width: 640, height: 48 } }
const pill: BarBand = { place: 'pill', rect: { left: 780, top: 0, width: 64, height: 390 } }

type BarProps = Parameters<typeof RemoteBarView>[0]
const props = (control: CardControl, more: Partial<BarProps> = {}): BarProps => ({
  control, where: 'away', connection: 'live', zoomed: false, now: 1000, error: null, busy: false,
  onTake: vi.fn(), onGive: vi.fn(), onEnd: vi.fn(), onFit: vi.fn(), band: row, ...more
})
const root = (p: BarProps): ReactElement<Record<string, unknown>> => {
  const element = RemoteBarView(p)
  if (!isValidElement(element)) throw new Error('no element')
  return element as ReactElement<Record<string, unknown>>
}
const fakeEvent = () => ({ stopPropagation: vi.fn(), preventDefault: vi.fn() })
const lines = (html: string): number => (html.match(/<p /g) ?? []).length

describe('RemoteBarView in its band', () => {
  it('fills its band exactly, so a press anywhere in it is a press on the bar', () => {
    for (const band of [row, pill]) {
      const style = root(props(watching, { band })).props.style as Record<string, number>
      expect(style).toMatchObject({ left: band.rect.left, top: band.rect.top, width: band.rect.width, height: band.rect.height })
    }
  })

  it('a press, a touch, a click and a wheel on the bar never go on to the machine', () => {
    const element = root(props(holding))
    for (const handler of ['onPointerDown', 'onTouchStart', 'onTouchEnd', 'onClick', 'onWheel', 'onContextMenu']) {
      const event = fakeEvent()
      ;(element.props[handler] as (e: unknown) => void)(event)
      expect(event.stopPropagation, handler).toHaveBeenCalled()
    }
  })

  it('every native listener on the frame knows the bar is a control', () => {
    expect(FRAME_CONTROLS).toContain('.rp-bar')
    expect(FRAME_CONTROLS).toContain('.rp-cover')
  })

  it('view only and in control have the same lines, so the band keeps its height', () => {
    const html = (control: CardControl) => renderToStaticMarkup(<RemoteBarView {...props(control)} />)
    expect(lines(html(watching))).toBe(lines(html(holding)))
    expect(html(watching)).toContain('Take control')
    expect(html(holding)).toContain('Give back')
  })

  it('an error takes the place of the control line instead of adding one', () => {
    const plain = renderToStaticMarkup(<RemoteBarView {...props(watching)} />)
    const failed = renderToStaticMarkup(<RemoteBarView {...props(watching, { error: 'iPad has control of this card.' })} />)
    expect(failed).toContain('iPad has control of this card.')
    expect(lines(failed)).toBe(lines(plain))
  })

  it('the frame’s own buttons ride in the bar, off the picture', () => {
    const html = renderToStaticMarkup(<RemoteBarView {...props(holding, { extras: <button type="button">⌨</button> })} />)
    expect(html).toContain('⌨')
  })

  it('the pill keeps every action, named for a screen reader', () => {
    const html = renderToStaticMarkup(<RemoteBarView {...props(watching, { band: pill, zoomed: true })} />)
    expect(html).toContain('aria-label="Take control"')
    expect(html).toContain('aria-label="Fit"')
    expect(html).toContain('aria-label="End session"')
    expect(html).toContain('rp-bar-pill')
  })
})

describe('remoteBarControl', () => {
  const status = (more: Partial<UseStatus>): UseStatus => ({ state: 'live', message: null, use: 'computer', input: false, control: watching, ...more }) as UseStatus

  it('a computer with a desk has a bar in both modes, so its band is reserved in both', () => {
    expect(remoteBarControl(status({}))).toEqual(watching)
    expect(remoteBarControl(status({ control: holding, input: true }))).toEqual(holding)
  })

  it('no bar for a phone, an offline screen, or a closed window', () => {
    expect(remoteBarControl(status({ use: 'phone' }))).toBeNull()
    expect(remoteBarControl(status({ state: 'offline' }))).toBeNull()
    expect(remoteBarControl(status({ state: 'offline', gone: 'window' }))).toBeNull()
    expect(remoteBarControl(null)).toBeNull()
  })
})
