import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createVersionWatch, type VersionDeps } from '../src/renderer/src/console/console-version'
import { NewerBuildView } from '../src/renderer/src/console/NewerBuild'

/**
 * A NEWER CONSOLE HAS BEEN DEPLOYED (console/console-version.ts). The page is
 * held by its worker, so a tab left open keeps the build it was opened with.
 * It asks the host which build is out there when it comes back to the front;
 * when that is not its own, it says so in one line and loads the new one WHEN
 * THE PERSON PRESSES, never by itself: nothing reloads under a finger.
 */

const waitingWorker = () => ({ postMessage: vi.fn() })

function bed(over: Partial<VersionDeps> = {}) {
  const waiting = waitingWorker()
  const registration = { update: vi.fn(async () => undefined), waiting: null as ReturnType<typeof waitingWorker> | null }
  const reload = vi.fn()
  let onControllerChange: (() => void) | null = null
  const deps: VersionDeps = {
    own: 'aaaaaaaaaaaa',
    fetchVersion: vi.fn(async () => ({ version: '0.6.0', build: 'aaaaaaaaaaaa' })),
    registration: async () => registration,
    onControllerChange: (listener) => void (onControllerChange = listener),
    reload,
    ...over
  }
  const watch = createVersionWatch(deps)
  return { watch, deps, registration, waiting, reload, controllerChanged: () => onControllerChange?.() }
}

describe('the console learns that a newer build is out', () => {
  it('says nothing while the host serves the build it is', async () => {
    const { watch, registration } = bed()
    await watch.check()
    expect(watch.get()).toEqual({ newer: false, updating: false })
    expect(registration.update).not.toHaveBeenCalled()
  })

  it('says so when the host serves another build, and has the browser fetch it', async () => {
    const { watch, registration } = bed({ fetchVersion: async () => ({ version: '0.6.1', build: 'bbbbbbbbbbbb' }) })
    const seen: boolean[] = []
    watch.subscribe(() => seen.push(watch.get().newer))
    await watch.check()
    expect(watch.get().newer).toBe(true)
    expect(seen).toEqual([true])
    expect(registration.update).toHaveBeenCalledTimes(1)
  })

  it('is not moved by an answer that is no version, or by none: it stays as it was', async () => {
    for (const fetchVersion of [async () => null, async () => ({ build: 7 }) as never, async () => Promise.reject(new Error('offline'))]) {
      const { watch } = bed({ fetchVersion })
      await watch.check()
      expect(watch.get().newer).toBe(false)
    }
  })

  it('a page with no build of its own (served unbuilt) never asks', async () => {
    const fetchVersion = vi.fn(async () => ({ version: 'x', build: 'bbbbbbbbbbbb' }))
    const { watch } = bed({ own: null, fetchVersion })
    await watch.check()
    expect(fetchVersion).not.toHaveBeenCalled()
    expect(watch.get().newer).toBe(false)
  })
})

describe('the newer build is loaded when the person asks, and only then', () => {
  it('nothing reloads on its own, whatever is learned', async () => {
    const { watch, reload, registration, waiting } = bed({ fetchVersion: async () => ({ version: '0.6.1', build: 'bbbbbbbbbbbb' }) })
    registration.waiting = waiting
    await watch.check()
    await watch.check()
    expect(reload).not.toHaveBeenCalled()
    expect(waiting.postMessage).not.toHaveBeenCalled()
  })

  it('pressing asks the waiting worker in, and the page loads again once it has taken over', async () => {
    const { watch, reload, registration, waiting, controllerChanged } = bed({ fetchVersion: async () => ({ version: '0.6.1', build: 'bbbbbbbbbbbb' }) })
    registration.waiting = waiting
    await watch.check()
    await watch.update()
    expect(watch.get().updating).toBe(true)
    expect(waiting.postMessage).toHaveBeenCalledWith('take-over')
    expect(reload).not.toHaveBeenCalled()
    controllerChanged()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('with no worker waiting (none registered, or it is still fetching), pressing loads the page again from the host', async () => {
    const { watch, reload } = bed({ fetchVersion: async () => ({ version: '0.6.1', build: 'bbbbbbbbbbbb' }), registration: async () => null })
    await watch.check()
    await watch.update()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a worker taking over that nobody asked for (another tab pressed) reloads nothing here', async () => {
    const { reload, controllerChanged } = bed()
    controllerChanged()
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('the line', () => {
  const draw = (newer: boolean, updating: boolean): string => renderToStaticMarkup(createElement(NewerBuildView, { newer, updating, onUpdate: () => undefined }))

  it('is not there until a newer build is out', () => {
    expect(draw(false, false)).toBe('')
  })

  it('says a newer console is ready and offers the one button; once pressed it says it is updating and offers nothing', () => {
    expect(draw(true, false)).toContain('A newer console is ready.')
    expect(draw(true, false)).toContain('<button')
    expect(draw(true, true)).toContain('Updating…')
    expect(draw(true, true)).not.toContain('<button')
  })
})
