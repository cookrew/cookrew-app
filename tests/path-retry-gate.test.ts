// TRY AGAIN, and what has to be true about it.
//
// The button is the one thing on that panel a reader can do without leaving
// the page, so the two rules are: it must run the race the switcher owns
// (never a second one beside it), and the press must not resolve until that
// race has settled — a button that stops saying TRYING… before there is a
// result is the failure the whole panel exists to end.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  offerPathRetry,
  pathRetryOffered,
  resetPathRetryGate,
  retryPath
} from '../src/renderer/src/path-retry-gate'

afterEach(() => resetPathRetryGate())

describe('the retry gate', () => {
  it('offers nothing until the switcher registers one', () => {
    expect(pathRetryOffered()).toBe(false)
  })

  it('is a no-op before then, rather than a button that pretends', async () => {
    await expect(retryPath()).resolves.toBeUndefined()
  })

  it('runs the handler the switcher registered', async () => {
    const handler = vi.fn(async () => undefined)
    offerPathRetry(handler)
    expect(pathRetryOffered()).toBe(true)
    await retryPath()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not resolve until the race does', async () => {
    let finish: () => void = () => undefined
    offerPathRetry(() => new Promise<void>((resolve) => void (finish = resolve)))
    let settled = false
    const press = retryPath().then(() => void (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await press
    expect(settled).toBe(true)
  })

  it('swallows a race that threw — the stores already carry the outcome', async () => {
    offerPathRetry(async () => {
      throw new Error('no card')
    })
    await expect(retryPath()).resolves.toBeUndefined()
  })

  it('drops only its OWN handler, so a re-registered switcher survives', async () => {
    // Same shape as the local-network gate: a remount registers the new
    // handler before the old one's cleanup runs, and a blind clear would
    // leave the button dead with no way to tell.
    const old = vi.fn(async () => undefined)
    const fresh = vi.fn(async () => undefined)
    const dropOld = offerPathRetry(old)
    offerPathRetry(fresh)
    dropOld()
    expect(pathRetryOffered()).toBe(true)
    await retryPath()
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(old).not.toHaveBeenCalled()
  })

  it('stops offering once the switcher drops its own handler', () => {
    const drop = offerPathRetry(async () => undefined)
    drop()
    expect(pathRetryOffered()).toBe(false)
  })
})
