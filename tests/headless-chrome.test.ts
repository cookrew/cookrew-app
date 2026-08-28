import { describe, expect, it } from 'vitest'
import {
  STATIC_FRAME_HEARTBEAT_MS,
  headlessLaunchArgs,
  shouldEmitFrame
} from '../src/main/headless-chrome'

describe('headless profile storage flags', () => {
  it('disables background components and on-device model downloads per profile', () => {
    const args = headlessLaunchArgs('/profiles/browser-1', 720, 560, 'https://example.test')
    expect(args).toContain('--disable-background-networking')
    expect(args).toContain('--disable-component-update')
    expect(args).toContain('--disable-sync')
    const features = args.find((arg) => arg.startsWith('--disable-features=')) ?? ''
    expect(features).toContain('OptimizationGuideModelDownloading')
    expect(features).toContain('OnDeviceModel')
  })
})

describe('headless static-frame liveness', () => {
  it('deduplicates rapid repeats but emits a heartbeat before the UI stale window', () => {
    expect(shouldEmitFrame('same', 'same', 100, 0)).toBe(true)
    expect(shouldEmitFrame('same', 'same', STATIC_FRAME_HEARTBEAT_MS, 1)).toBe(false)
    expect(shouldEmitFrame('same', 'same', STATIC_FRAME_HEARTBEAT_MS + 1, 1)).toBe(true)
  })

  it('always emits changed frames', () => {
    expect(shouldEmitFrame('next', 'previous', 2, 1)).toBe(true)
  })
})
