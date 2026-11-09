import { describe, expect, it } from 'vitest'
import {
  STATIC_FRAME_HEARTBEAT_MS,
  headlessLaunchArgs,
  internalPageKind,
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

describe('headless sign-in flag (owner ruling 2026-11-08)', () => {
  it('turns off the AutomationControlled blink feature so a remote-debugged card is not marked navigator.webdriver', () => {
    const args = headlessLaunchArgs('/profiles/browser-1', 720, 560, 'https://example.test')
    expect(args).toContain('--disable-blink-features=AutomationControlled')
  })

  it('keeps Google sign-in on the web only, so Chrome never adopts the account', () => {
    const args = headlessLaunchArgs('/profiles/browser-1', 720, 560, 'https://example.test')
    expect(args).toContain('--allow-browser-signin=false')
  })

  it('keeps the page address last, after every flag', () => {
    const args = headlessLaunchArgs('/profiles/browser-1', 720, 560, 'https://example.test')
    expect(args.at(-1)).toBe('https://example.test')
  })
})

describe('pages Chrome opens on its own', () => {
  it('tells chrome:// pages, Chrome UI bubbles and sites apart', () => {
    expect(internalPageKind('chrome://settings/help')).toBe('page')
    expect(internalPageKind('chrome-untrusted://print/')).toBe('page')
    expect(internalPageKind('chrome://signin-dice-web-intercept.top-chrome/chrome-signin')).toBe('browser-ui')
    expect(internalPageKind('https://accounts.google.com/')).toBe('site')
    expect(internalPageKind('about:blank')).toBe('site')
    expect(internalPageKind('')).toBe('site')
    expect(internalPageKind('https://chrome.example/settings')).toBe('site')
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
