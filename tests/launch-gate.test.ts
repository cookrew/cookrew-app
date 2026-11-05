import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchRefusal } from '../src/renderer/src/prompt/launch-gate'
import * as api from '../src/renderer/src/api'

const failure = { kind: 'folder-missing', why: 'The folder /x does not exist.', fix: 'Create or restore it, then send again.', blocked: true, exitCode: null, lastLines: [], at: 1 }

describe('launchRefusal', () => {
  afterEach(() => vi.restoreAllMocks())

  const bridge = (launchCheck: unknown): void => {
    vi.spyOn(api, 'cookrew').mockReturnValue({ launchCheck } as unknown as ReturnType<typeof api.cookrew>)
  }

  it('says why and what to do, so the box can keep the words', async () => {
    bridge(async () => failure)
    await expect(launchRefusal('a')).resolves.toBe('Not sent: The folder /x does not exist. Create or restore it, then send again.')
  })

  it('nothing in the way is no refusal', async () => {
    bridge(async () => null)
    await expect(launchRefusal('a')).resolves.toBeNull()
  })

  it('an older bridge is no refusal', async () => {
    bridge(undefined)
    await expect(launchRefusal('a')).resolves.toBeNull()
  })

  it('a failed check is no refusal: main still refuses for itself', async () => {
    bridge(async () => {
      throw new Error('gone')
    })
    await expect(launchRefusal('a')).resolves.toBeNull()
  })
})

describe('the launch check on a slugged phone', () => {
  it('is a node route, so the scope check runs on it', async () => {
    const { nodeIdOfRoute, scopedRouteSupported } = await import('../src/main/mobile-slug-route')
    expect(scopedRouteSupported('/api/terminal/abc/launch-check')).toBe(true)
    expect(nodeIdOfRoute('/api/terminal/abc/launch-check')).toBe('abc')
  })

  it('the stray list stays off slugged routes: it is the whole machine, not one workspace', async () => {
    const { scopedRouteSupported } = await import('../src/main/mobile-slug-route')
    expect(scopedRouteSupported('/api/strays')).toBe(false)
    expect(scopedRouteSupported('/api/strays/cookrew_a/end')).toBe(false)
  })
})

describe('words lost on a wake that took a while', () => {
  it('a wake outlasts the refusal window: the words still come back', async () => {
    const { noteSent, takeRefused, REFUSED_WINDOW_MS, WAKE_WINDOW_MS } = await import('../src/renderer/src/prompt/input-refused')
    noteSent({ id: 'a', box: 'box', words: 'hello', at: 0 })
    expect(takeRefused('a', '\r', REFUSED_WINDOW_MS + 1)).toBeNull()
    expect(takeRefused('a', '\r', WAKE_WINDOW_MS - 1, WAKE_WINDOW_MS)?.words).toBe('hello')
  })
})
