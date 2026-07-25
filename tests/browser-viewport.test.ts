import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_VIEWPORT_GRACE_MS,
  BrowserViewportCoordinator,
  VIEWPORT_OWNER_COOLDOWN_MS,
  VIEWPORT_RELEASE_GRACE_MS
} from '../src/main/browser-viewport'

const desktop = { width: 720, height: 560, mobile: false }
const phone = { width: 390, height: 700, mobile: true }

describe('BrowserViewportCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })

  afterEach(() => vi.useRealTimers())

  it('auto-fits the sole viewer and revisions only after metrics apply', async () => {
    const apply = vi.fn(() => Promise.resolve())
    const coordinator = new BrowserViewportCoordinator(desktop, apply)
    coordinator.registerViewer('phone')
    coordinator.offer('phone', phone)

    expect(coordinator.state).toMatchObject({ ownerId: 'phone', revision: 1, transitioning: true })
    await vi.advanceTimersByTimeAsync(250)
    expect(apply).toHaveBeenCalledWith(phone)
    expect(coordinator.state).toMatchObject({ ...phone, revision: 2, transitioning: false })
  })

  it('keeps the first viewport sticky with two viewers until explicit takeover', async () => {
    const apply = vi.fn(() => Promise.resolve())
    const coordinator = new BrowserViewportCoordinator(desktop, apply)
    coordinator.registerViewer('desktop')
    coordinator.offer('desktop', desktop)
    coordinator.registerViewer('phone')
    coordinator.offer('phone', phone)

    expect(coordinator.state.ownerId).toBe('desktop')
    expect(coordinator.claim('phone', phone)).toBe(false)
    await vi.advanceTimersByTimeAsync(VIEWPORT_OWNER_COOLDOWN_MS)
    expect(coordinator.claim('phone', phone)).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(coordinator.state).toMatchObject({ ownerId: 'phone', mobile: true, revision: 2 })
  })

  it('blocks reflow throughout agent activity and its post-command grace', async () => {
    const coordinator = new BrowserViewportCoordinator(desktop, vi.fn(() => Promise.resolve()))
    coordinator.registerViewer('phone')
    const releaseAgent = await coordinator.beginAgentActivity()
    coordinator.offer('phone', phone)
    expect(coordinator.state).toMatchObject({ ownerId: null, agentHeld: true })
    expect(coordinator.claim('phone', phone)).toBe(false)

    releaseAgent()
    await vi.advanceTimersByTimeAsync(AGENT_VIEWPORT_GRACE_MS - 1)
    expect(coordinator.state.ownerId).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(coordinator.state).toMatchObject({ ownerId: 'phone', agentHeld: false })
  })

  it('cancels a queued viewer resize when agent automation starts', async () => {
    const apply = vi.fn(() => Promise.resolve())
    const coordinator = new BrowserViewportCoordinator(desktop, apply)
    coordinator.registerViewer('phone')
    coordinator.offer('phone', phone)

    const releaseAgent = await coordinator.beginAgentActivity()
    coordinator.offer('phone', { width: 400, height: 720, mobile: true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(apply).not.toHaveBeenCalled()
    expect(coordinator.state).toMatchObject({ revision: 1, agentHeld: true })

    releaseAgent()
    await vi.advanceTimersByTimeAsync(AGENT_VIEWPORT_GRACE_MS + 250)
    expect(apply).toHaveBeenCalledWith({ width: 400, height: 720, mobile: true })
    expect(coordinator.state.revision).toBe(2)
  })

  it('retains the last viewer layout across disconnect and ignores node-size syncs', async () => {
    const apply = vi.fn(() => Promise.resolve())
    const coordinator = new BrowserViewportCoordinator(desktop, apply)
    coordinator.registerViewer('phone')
    coordinator.offer('phone', phone)
    await vi.advanceTimersByTimeAsync(250)
    apply.mockClear()

    coordinator.unregisterViewer('phone')
    await vi.advanceTimersByTimeAsync(VIEWPORT_RELEASE_GRACE_MS)
    coordinator.setDefault({ width: 1000, height: 800, mobile: false })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(coordinator.state).toMatchObject({ ...phone, ownerId: null, viewerCount: 0 })
    expect(apply).not.toHaveBeenCalled()
  })

  it('hands ownership to the only actively offered viewer after release grace', async () => {
    const apply = vi.fn(() => Promise.resolve())
    const coordinator = new BrowserViewportCoordinator(desktop, apply)
    coordinator.registerViewer('desktop')
    coordinator.offer('desktop', desktop)
    coordinator.registerViewer('phone')
    coordinator.offer('phone', phone)

    coordinator.release('desktop')
    await vi.advanceTimersByTimeAsync(VIEWPORT_RELEASE_GRACE_MS + 250)

    expect(coordinator.state).toMatchObject({
      ownerId: 'phone',
      viewerCount: 2,
      mobile: true,
      revision: 2
    })
  })

  it('does not reapply tiny owner size jitter inside hysteresis', async () => {
    const apply = vi.fn(() => Promise.resolve())
    const coordinator = new BrowserViewportCoordinator(desktop, apply)
    coordinator.registerViewer('desktop')
    coordinator.offer('desktop', { width: 727, height: 568, mobile: false })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(apply).not.toHaveBeenCalled()
    expect(coordinator.state.revision).toBe(1)
  })

  it('cancels a transient resize that returns to the applied size during debounce', async () => {
    const apply = vi.fn(() => Promise.resolve())
    const coordinator = new BrowserViewportCoordinator(desktop, apply)
    coordinator.registerViewer('desktop')
    coordinator.offer('desktop', { width: 900, height: 700, mobile: false })
    coordinator.offer('desktop', desktop)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(apply).not.toHaveBeenCalled()
    expect(coordinator.state).toMatchObject({ ...desktop, revision: 1, transitioning: false })
  })

  it('queues a return to the prior size when a metrics change is already in flight', async () => {
    let finishFirst: () => void = () => undefined
    const apply = vi.fn(() =>
      apply.mock.calls.length === 1
        ? new Promise<void>((resolve) => { finishFirst = resolve })
        : Promise.resolve()
    )
    const coordinator = new BrowserViewportCoordinator(desktop, apply)
    coordinator.registerViewer('viewer')
    coordinator.offer('viewer', phone)
    await vi.advanceTimersByTimeAsync(250)

    coordinator.offer('viewer', desktop)
    finishFirst()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(apply).toHaveBeenNthCalledWith(1, phone)
    expect(apply).toHaveBeenNthCalledWith(2, desktop)
    expect(coordinator.state).toMatchObject({ ...desktop, revision: 3, transitioning: false })
  })
})
