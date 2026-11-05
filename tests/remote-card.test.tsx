// THE CARD, THE SHEET AND THE HOST SAY THE SAME STATE, DRAWN FROM THE SAME MODEL.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RemoteBarView, RemoteConfirmView, RemoteHostBannerView, RemotePanel, coverState, frameIsStale } from '../src/renderer/src/use/RemotePanel'
import { switchAnswer } from '../src/renderer/src/use/RemoteSwitch'
import type { CardControl, RemoteBuild, RemoteState, RemoteStateId } from '../src/shared/remote-access'
import type { UseStatus } from '../src/shared/use-signal'

const packaged: RemoteBuild = { settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' }
const state = (id: RemoteStateId, more: Partial<RemoteState> = {}): RemoteState => ({
  id, platform: 'darwin', build: packaged, then: null, detail: null, lastSeenAt: null, until: null, waiting: false, ...more
})
const panel = (s: RemoteState, where: 'here' | 'away' = 'here', note: string | null = null): string =>
  renderToStaticMarkup(<RemotePanel state={s} where={where} busy={false} note={note} onAct={() => undefined} />)

describe('RemotePanel', () => {
  it.each([
    ['needs-screen-recording', 'Screen Recording is off', 'Open System Settings'],
    ['needs-restart', 'Restart to finish', 'Restart Cookrew'],
    ['needs-accessibility', 'Accessibility is off', 'Open System Settings'],
    ['locked', 'This Mac is locked', 'Check again'],
    ['display-asleep', 'The display is asleep', 'Check again'],
    ['unreachable', 'Cannot reach this Mac', 'Check again']
  ] as Array<[RemoteStateId, string, string]>)('%s: one sentence and the next action', (id, title, button) => {
    const html = panel(state(id))
    expect(html).toContain(title)
    expect(html).toContain(button)
    expect(html).not.toContain('offline')
  })

  it('away from the Mac the jump says where it lands, and the words say who it needs', () => {
    const html = panel(state('needs-screen-recording'), 'away')
    expect(html).toContain('needs you at the Mac')
    expect(html).toContain('Open it on the Mac for later')
    expect(html).not.toContain('Open System Settings<')
  })

  it('says what comes after the lock', () => {
    expect(panel(state('locked', { then: 'needs-screen-recording' }), 'away')).toContain('Screen Recording is off too')
  })

  it('says what the last action did', () => {
    expect(panel(state('needs-screen-recording'), 'here', 'Turn on Cookrew, then Check again.')).toContain('Turn on Cookrew, then Check again.')
  })

  it('a press on a button is one action, with the state it came from', () => {
    const onAct = vi.fn()
    const element = RemotePanel({ state: state('needs-accessibility'), where: 'here', busy: false, note: null, onAct })
    const buttons = JSON.stringify(element)
    expect(buttons).toContain('Open System Settings')
  })
})

describe('coverState: what stands over the frame', () => {
  const live: UseStatus = { state: 'live', message: null, use: 'computer', input: false }
  const locked: UseStatus = { state: 'offline', message: 'x', use: 'computer', input: false, remote: state('locked', { lastSeenAt: 5 }) }

  it('a live screen has nothing over it', () => {
    expect(coverState({ status: live, lineLost: false, lastHeardAt: 1 })).toBeNull()
  })

  it('a blocked screen is covered, so no stale frame can pass for live', () => {
    expect(coverState({ status: locked, lineLost: false, lastHeardAt: 1 })?.id).toBe('locked')
  })

  it('a lost line on a computer card is Mac unreachable, with when it was last heard', () => {
    expect(coverState({ status: live, lineLost: true, lastHeardAt: 42 })).toMatchObject({ id: 'unreachable', lastSeenAt: 42 })
  })

  it('a state already on the card outranks a lost line: Stopped stays Stopped through the redials', () => {
    const stopped: UseStatus = { ...locked, remote: state('stopped') }
    expect(coverState({ status: stopped, lineLost: true, lastHeardAt: 42 })?.id).toBe('stopped')
  })

  it('a phone or a camera is not covered: it has no desk', () => {
    expect(coverState({ status: { ...live, use: 'phone' }, lineLost: true, lastHeardAt: 42 })).toBeNull()
    expect(coverState({ status: null, lineLost: false, lastHeardAt: null })).toBeNull()
  })

  it('a closed window keeps today\'s way on, not a cover', () => {
    const gone: UseStatus = { ...live, state: 'offline', gone: 'window', message: 'closed' }
    expect(coverState({ status: gone, lineLost: false, lastHeardAt: 1 })).toBeNull()
  })
})

describe('frameIsStale: the picture has stopped but nothing says why yet', () => {
  it('only on a computer card that has a picture and no fresh frame', () => {
    expect(frameIsStale({ computer: true, hasPicture: true, live: false })).toBe(true)
    expect(frameIsStale({ computer: true, hasPicture: true, live: true })).toBe(false)
    expect(frameIsStale({ computer: false, hasPicture: true, live: false })).toBe(false)
  })
})

describe('RemoteBarView', () => {
  const base: CardControl = { switchOn: true, until: null, heldBy: null, awake: true, machine: 'darwin' }
  const bar = (control: CardControl, where: 'here' | 'away' = 'away', more: Partial<Parameters<typeof RemoteBarView>[0]> = {}): string =>
    renderToStaticMarkup(
      <RemoteBarView control={control} where={where} connection="live" zoomed={false} now={1000} error={null} busy={false} onTake={() => undefined} onGive={() => undefined} onEnd={() => undefined} onFit={() => undefined} {...more} />
    )

  it('view only by default, with Take control one tap away', () => {
    const html = bar(base)
    expect(html).toContain('View only')
    expect(html).toContain('Take control')
  })

  it('no Take control when the machine switch is off, and it says only the Mac can change that', () => {
    const html = bar({ ...base, switchOn: false })
    expect(html).not.toContain('Take control')
    expect(html).toContain('at the Mac')
  })

  it('in control: how long is left and the way to give it back', () => {
    const html = bar({ ...base, until: 1000 + 14 * 60_000 })
    expect(html).toContain('You have control')
    expect(html).toContain('14 min left')
    expect(html).toContain('Give back')
    expect(html).not.toContain('Take control')
  })

  it('someone else in control is named, and offers nothing to press', () => {
    const html = bar({ ...base, heldBy: 'Pixel 9' })
    expect(html).toContain('Pixel 9 has control')
    expect(html).not.toContain('Take control')
  })

  it('says it is keeping the Mac awake, only when it is', () => {
    expect(bar(base)).toContain('Keeping the Mac awake while you watch')
    expect(bar({ ...base, awake: false })).not.toContain('Keeping the Mac awake')
  })

  it('always has a clear way out, and the connection state', () => {
    expect(bar(base)).toContain('End session')
    expect(bar(base)).toContain('Live')
    expect(bar(base, 'away', { connection: 'reconnecting' })).toContain('Reconnecting')
    expect(bar(base, 'away', { connection: 'stalled' })).toContain('Waiting for a frame')
  })

  it('Fit appears when the picture is zoomed', () => {
    expect(bar(base)).not.toContain('>Fit<')
    expect(bar(base, 'away', { zoomed: true })).toContain('>Fit<')
  })

  it('a Linux machine never offers control', () => {
    const html = bar({ ...base, switchOn: false, machine: 'linux' })
    expect(html).not.toContain('Take control')
    expect(html).toContain('View only')
    expect(html).not.toMatch(/\bMac\b/)
  })

  it('says why a Take control was refused', () => {
    expect(bar(base, 'away', { error: 'iPad has control of this card.' })).toContain('iPad has control of this card.')
  })
})

describe('the switch says what was pressed, not what it last heard', () => {
  it('a press sends the box\'s own new value', async () => {
    const set = vi.fn(async () => ({ ok: true as const }))
    expect(switchAnswer(set, false)).toBeInstanceOf(Promise)
    expect(set).toHaveBeenCalledWith(false)
  })
})

describe('RemoteConfirmView', () => {
  it('the restart question says what happens to the agents, before it happens', () => {
    const html = renderToStaticMarkup(<RemoteConfirmView confirm={{ title: 'Restart Cookrew?', sentence: 'Agents keep running.', yes: 'Restart Cookrew' }} onYes={() => undefined} onNo={() => undefined} />)
    expect(html).toContain('Agents keep running.')
    expect(html).toContain('Cancel')
  })
})

describe('RemoteHostBannerView', () => {
  it('who, what, awake, and a Stop', () => {
    const html = renderToStaticMarkup(<RemoteHostBannerView view={{ rows: [{ key: 'k', who: 'Pixel 9', card: 'c', cardName: 'Main display', mode: 'watching', since: 0 }], awake: true }} platform="darwin" onStop={() => undefined} />)
    expect(html).toContain('Pixel 9 is watching Main display')
    expect(html).toContain('Keeping this Mac awake')
    expect(html).toContain('Stop')
  })

  it('nobody on the machine draws nothing', () => {
    expect(renderToStaticMarkup(<RemoteHostBannerView view={{ rows: [], awake: false }} platform="darwin" onStop={() => undefined} />)).toBe('')
  })
})
