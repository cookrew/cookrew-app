// ONE REAL VIEWER ON ONE REAL SCREEN, ON FAKE SOURCES: the cast, the pixel
// instance and the desk together, so what is proved is the wiring.
import { describe, expect, it, vi } from 'vitest'
import { VIEWPORT_DEBOUNCE_MS } from '../src/main/browser-viewport'
import { CastViewer, type ViewerSink } from '../src/main/cast-viewer'
import { DeviceBlockedError, PixelInstance, type PixelDevice } from '../src/main/pixel-instance'
import { createRemoteDesk, remoteGate, type RemoteDesk, type RemoteSession } from '../src/main/remote-desk'
import type { Gesture } from '../src/main/vphone-input'
import { MAC_VIEWER, type RemoteState, type ViewerWho } from '../src/shared/remote-access'
import { parseUseUrl } from '../src/shared/use-url'

const phone: ViewerWho = { key: 'device:p', name: 'Pixel', here: false }
const tablet: ViewerWho = { key: 'device:t', name: 'iPad', here: false }

function sink(): ViewerSink & { sent: Array<Record<string, unknown>>; closed: boolean } {
  const sent: Array<Record<string, unknown>> = []
  const out = {
    sent,
    closed: false,
    sendControl: (message: Record<string, unknown>) => void sent.push(message),
    frameReady: () => true,
    sendFrame: (frame: { seq: number }) => void sent.push({ t: 'frame', seq: frame.seq }),
    onceReady: () => undefined,
    close: () => {
      out.closed = true
    }
  }
  return out as never
}

function rig() {
  const session: RemoteSession = { locked: false, displayAsleep: false, grant: true }
  const dropped: string[] = []
  const records: string[] = []
  let refresh: () => void = () => undefined
  const desk: RemoteDesk = createRemoteDesk({
    platform: 'darwin',
    build: () => ({ settingsName: 'Electron', sourceBuild: true, restart: 'by-hand', agents: 'keep' }),
    linuxRefusal: () => null,
    screenAccess: () => 'granted',
    accessibility: () => true,
    session: async () => session,
    settings: { read: () => ({ waiting: null, holdUntil: 0 }), write: () => undefined },
    servedWorkspace: () => false,
    workspaceOfCard: () => 'ws',
    cardName: () => 'Main display',
    record: (type) => records.push(type),
    keepAwake: { start: () => undefined, stop: () => undefined },
    host: () => undefined,
    refreshCards: () => refresh(),
    dropViewers: (cards) => dropped.push(...cards),
    openSettings: async () => undefined,
    relaunch: () => undefined
  })
  const gestures: Gesture[] = []
  const remote = remoteGate(desk, 'card')
  const device: PixelDevice = {
    target: parseUseUrl('screen://main')!,
    remote,
    open: async () => ({ width: 1000, height: 800 }),
    capture: async () => {
      const blocked = await remote.blocked()
      if (blocked) throw new DeviceBlockedError(blocked)
      return { jpeg: Buffer.from(`frame-${Math.random()}`).toString('base64') }
    },
    inputRefusal: () => remote.inputRefusal(),
    perform: async (gesture) => void gestures.push(gesture)
  }
  const instance = new PixelInstance({ url: 'screen://main', device, schedule: () => () => undefined })
  refresh = () => instance.refreshStatus()
  const watch = (who: ViewerWho) => {
    const line = sink()
    const viewer = new CastViewer(line, () => undefined, 'card', who)
    viewer.attach(instance as never)
    return { line, viewer }
  }
  return { desk, session, gestures, instance, watch, dropped, records }
}

const lastStatus = (line: { sent: Array<Record<string, unknown>> }) => [...line.sent].reverse().find((m) => m.t === 'status') as (Record<string, unknown> & { remote?: RemoteState }) | undefined

/** A frame reaches every viewer: input is only ever mapped against a frame the viewer was sent. */
const frame = (instance: PixelInstance): void => {
  const meta = { deviceWidth: 1000, deviceHeight: 800, pageScaleFactor: 1, mobile: false, revision: instance.viewportState.revision }
  for (const listener of instance.frameListeners) listener(Buffer.from('frame').toString('base64'), meta)
}

const tapOn = (viewer: CastViewer, instance: PixelInstance): void => {
  const revision = instance.viewportState.revision
  for (const t of ['down', 'up']) viewer.handleMessage({ t, x: 10, y: 10, button: 'left', revision, frameSeq: 1 })
}

describe('a viewer of the Mac', () => {
  it('a page out of sight says so, apart from releasing the viewport, and is not counted as watching', async () => {
    const { instance, watch } = rig()
    await instance.start()
    const { viewer } = watch(phone)
    const hidden = vi.spyOn(instance, 'viewerHidden')
    viewer.handleMessage({ t: 'visibility', hidden: true })
    expect(hidden).toHaveBeenCalledWith(expect.any(String), true)
    viewer.handleMessage({ t: 'visibility', hidden: false })
    expect(hidden).toHaveBeenLastCalledWith(expect.any(String), false)
  })

  it('holding control, its tap reaches the hand through the whole line', async () => {
    const { desk, gestures, instance, watch } = rig()
    desk.setSwitch(true)
    await instance.start()
    const { viewer } = watch(phone)
    await desk.takeControl('card', phone)
    // A new viewer's viewport settles first: a press inside that window is dropped, by design.
    await new Promise((r) => setTimeout(r, VIEWPORT_DEBOUNCE_MS + 60))
    frame(instance)
    tapOn(viewer, instance)
    await new Promise((r) => setTimeout(r, 0))
    expect(gestures.map((g) => g.method)).toEqual(['input.tap'])
  })

  it('watches by default: the status says so, and a tap goes nowhere', async () => {
    const { desk, gestures, instance, watch } = rig()
    desk.setSwitch(true)
    await instance.start()
    const { line, viewer } = watch(phone)
    // A resting card opens as the viewer arrives: live a moment later.
    await new Promise((r) => setTimeout(r, 0))
    expect(lastStatus(line)).toMatchObject({ state: 'live', input: false, control: { switchOn: true, until: null } })
    await new Promise((r) => setTimeout(r, VIEWPORT_DEBOUNCE_MS + 60))
    frame(instance)
    tapOn(viewer, instance)
    await new Promise((r) => setTimeout(r, 0))
    expect(gestures).toEqual([])
  })

  it('hears a grant the moment it lands, and its own control only', async () => {
    const { desk, instance, watch } = rig()
    desk.setSwitch(true)
    await instance.start()
    const a = watch(phone)
    const b = watch(tablet)
    await desk.takeControl('card', phone)
    expect(lastStatus(a.line)).toMatchObject({ input: true, control: { heldBy: null } })
    expect((lastStatus(a.line)?.control as { until: number }).until).toBeGreaterThan(0)
    expect(lastStatus(b.line)).toMatchObject({ input: false, control: { until: null, heldBy: 'Pixel' } })
  })

  it('hears the switch go off, and input stops with it', async () => {
    const { desk, instance, watch } = rig()
    desk.setSwitch(true)
    await instance.start()
    const { line } = watch(phone)
    await desk.takeControl('card', phone)
    desk.setSwitch(false)
    expect(lastStatus(line)).toMatchObject({ input: false, control: { switchOn: false, until: null } })
  })

  it('the Mac\'s clipboard reaches the viewer driving and nobody else, whatever the watcher pressed', async () => {
    const { desk, instance, watch } = rig()
    desk.setSwitch(true)
    await instance.start()
    const driver = watch(phone)
    const watcher = watch(tablet)
    await desk.takeControl('card', phone)
    frame(instance)
    tapOn(driver.viewer, instance)
    tapOn(watcher.viewer, instance)
    for (const listener of instance.copyListeners) listener('482913')
    expect(driver.line.sent.filter((m) => m.t === 'copy')).toHaveLength(1)
    expect(watcher.line.sent.filter((m) => m.t === 'copy')).toHaveLength(0)
  })

  it('leaving is a logged stop, whichever line it was on', async () => {
    const { instance, watch, records } = rig()
    await instance.start()
    const { viewer } = watch(phone)
    expect(records).toContain('remote.view-started')
    viewer.close()
    expect(records).toContain('remote.view-ended')
  })

  it('after Stop at the Mac, a redial is told so and is not attached', async () => {
    const { desk, instance, watch, dropped } = rig()
    await instance.start()
    watch(phone)
    desk.stopAll()
    expect(dropped).toEqual(['card'])
    const again = watch(phone)
    expect(lastStatus(again.line)).toMatchObject({ state: 'offline', input: false, remote: { id: 'stopped' } })
    expect(again.line.closed).toBe(true)
    expect(again.line.sent.some((m) => m.t === 'ready')).toBe(false)
  })

  it('the Mac\'s own window still sees its card after Stop', async () => {
    const { desk, instance, watch } = rig()
    await instance.start()
    desk.stopAll()
    const here = watch(MAC_VIEWER)
    expect(here.line.closed).toBe(false)
    expect(here.line.sent.some((m) => m.t === 'ready')).toBe(true)
  })
})
