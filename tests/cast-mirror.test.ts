// A MIRROR ON THE CAST LINE (main/cast-mirror.ts, main/cast-viewer.ts): a
// viewer reads the page as data and acts on one element by ref, before any
// frame or revision gate, and nothing it sends besides a ref, a verb and text
// reaches the page. Owner ruling 2026-11-23: local by default, no pixel fallback.
import { describe, expect, it, vi } from 'vitest'
import { CastViewer, MIRROR_QUEUE_MAX, type ViewerSink } from '../src/main/cast-viewer'
import { fitPage, mirrorRequest, MIRROR_TYPE_MAX } from '../src/main/cast-mirror'
import { actOnTab, type MirrorTab } from '../src/main/mirror-instance'
import { MIRROR_CDP } from '../src/main/dom-mirror'
import type { BrowserInstance } from '../src/main/browser-instance'
import type { MirrorCommand } from '../src/main/dom-mirror'
import type { MirrorPage } from '../src/shared/dom-mirror'
import type { ViewerWho } from '../src/shared/remote-access'

const phone: ViewerWho = { key: 'device:p', name: 'Pixel', here: false }

function sink(): ViewerSink & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    sendControl: (message) => void sent.push(message),
    frameReady: () => true,
    sendFrame: (frame) => void sent.push({ t: 'frame', seq: frame.seq }),
    onceReady: () => undefined,
    close: () => undefined
  }
}

const page = (title: string): MirrorPage => ({
  url: 'https://example.com/',
  title,
  blocks: [{ ref: 7, role: 'button', text: 'Archive' }],
  truncated: false,
  pixelOnly: false
})

interface FakeOptions {
  mayDrive?: (who: ViewerWho) => boolean
  agentHeld?: boolean
  mirror?: boolean
  read?: () => Promise<MirrorPage>
}

function fakeInstance(options: FakeOptions = {}) {
  const reads: string[] = []
  const acts: MirrorCommand[] = []
  let count = 0
  const frameListeners = new Set<(jpeg: string, meta: Record<string, unknown>) => void>()
  const instance = {
    frameListeners,
    viewportState: {
      width: 800,
      height: 600,
      mobile: false,
      revision: 3,
      ownerId: null,
      viewerCount: 1,
      agentHeld: options.agentHeld === true,
      transitioning: false
    },
    registerViewportViewer: () => undefined,
    unregisterViewportViewer: () => undefined,
    onViewportState: () => () => undefined,
    pageInfo: async () => ({ url: 'https://example.com/', title: 'Inbox', viewport: '800x600' }),
    dispatchInput: vi.fn(),
    ...(options.mayDrive ? { mayDrive: options.mayDrive } : {}),
    ...(options.mirror === false
      ? {}
      : {
          mirrorPage: async (url: string, title: string) => {
            reads.push(`${url}|${title}`)
            count += 1
            return options.read ? options.read() : page(`read ${count}`)
          },
          actMirror: async (command: MirrorCommand) => {
            acts.push(command)
            return { ok: true as const }
          }
        })
  }
  return { instance: instance as unknown as BrowserInstance, reads, acts, frameListeners }
}

function attached(options: FakeOptions = {}, who: ViewerWho = phone) {
  const out = sink()
  const fake = fakeInstance(options)
  const viewer = new CastViewer(out, () => undefined, 'card', who)
  viewer.attach(fake.instance)
  out.sent.length = 0
  return { viewer, out, ...fake }
}

const replies = (out: { sent: Array<Record<string, unknown>> }) => out.sent.filter((m) => m.t === 'dom' || m.t === 'dom-refused')

describe('a dom request on the cast line', () => {
  it('is answered with the page on the same line, with no frame ever painted', async () => {
    const { viewer, out, reads } = attached()
    viewer.handleMessage({ t: 'dom' })
    await vi.waitFor(() => expect(replies(out)).toHaveLength(1))
    expect(replies(out)[0]).toEqual({ t: 'dom', page: page('read 1') })
    expect(reads).toEqual(['https://example.com/|Inbox'])
  })

  it('a page the computer cannot read is said in words, not swapped for the screen', async () => {
    const { viewer, out } = attached({ read: async () => Promise.reject(new Error('no target')) })
    viewer.handleMessage({ t: 'dom' })
    await vi.waitFor(() => expect(replies(out)).toHaveLength(1))
    expect(replies(out)[0]).toMatchObject({ t: 'dom-refused', stage: 'read' })
    expect(out.sent.some((m) => m.t === 'frame')).toBe(false)
  })

  it('a card with no page to read (a use card) refuses the read', async () => {
    const { viewer, out } = attached({ mirror: false })
    viewer.handleMessage({ t: 'dom' })
    await vi.waitFor(() => expect(replies(out)).toHaveLength(1))
    expect(replies(out)[0]).toMatchObject({ t: 'dom-refused', stage: 'read' })
  })
})

describe('a dom-act on the cast line', () => {
  it('acts on the one element, then answers with a FRESH read', async () => {
    const { viewer, out, acts, reads } = attached()
    viewer.handleMessage({ t: 'dom' })
    viewer.handleMessage({ t: 'dom-act', ref: 7, act: 'press' })
    await vi.waitFor(() => expect(replies(out)).toHaveLength(2))
    expect(acts).toEqual([{ ref: 7, act: 'press' }])
    expect(reads).toHaveLength(2)
    expect(replies(out)[1]).toEqual({ t: 'dom', page: page('read 2') })
  })

  it('is refused for a viewer that may not drive, and nothing reaches the page', async () => {
    const { viewer, out, acts, reads } = attached({ mayDrive: () => false })
    viewer.handleMessage({ t: 'dom-act', ref: 7, act: 'press' })
    await vi.waitFor(() => expect(replies(out)).toHaveLength(1))
    expect(replies(out)[0]).toMatchObject({ t: 'dom-refused', stage: 'act' })
    expect(acts).toEqual([])
    expect(reads).toEqual([])
  })

  it('a viewer that may drive is let through by the same rule', async () => {
    const mayDrive = vi.fn((who: ViewerWho) => who.key === phone.key)
    const { viewer, out, acts } = attached({ mayDrive })
    viewer.handleMessage({ t: 'dom-act', ref: 7, act: 'check' })
    await vi.waitFor(() => expect(replies(out)).toHaveLength(1))
    expect(mayDrive).toHaveBeenCalledWith(phone)
    expect(acts).toEqual([{ ref: 7, act: 'check' }])
  })

  it('is refused while an agent holds the page', async () => {
    const { viewer, out, acts } = attached({ agentHeld: true })
    viewer.handleMessage({ t: 'dom-act', ref: 7, act: 'press' })
    await vi.waitFor(() => expect(replies(out)).toHaveLength(1))
    expect(replies(out)[0]).toMatchObject({ t: 'dom-refused', stage: 'act' })
    expect(acts).toEqual([])
  })

  it('carries a ref, a verb and text only: a method, selector, expression or function never passes', async () => {
    const { viewer, out, acts } = attached()
    viewer.handleMessage({
      t: 'dom-act',
      ref: 7,
      act: 'type',
      value: 'hello',
      method: 'Runtime.evaluate',
      expression: 'alert(1)',
      selector: '#x',
      functionDeclaration: 'function(){}'
    })
    await vi.waitFor(() => expect(replies(out)).toHaveLength(1))
    expect(acts).toEqual([{ ref: 7, act: 'type', value: 'hello' }])
    expect(Object.keys(acts[0]).sort()).toEqual(['act', 'ref', 'value'])
  })

  it.each([
    [{ t: 'dom-act', ref: 0, act: 'press' }],
    [{ t: 'dom-act', ref: 1.5, act: 'press' }],
    [{ t: 'dom-act', ref: '7', act: 'press' }],
    [{ t: 'dom-act', ref: 7, act: 'evaluate' }],
    [{ t: 'dom-act', ref: 7, act: 'type' }],
    [{ t: 'dom-act', ref: 7, act: 'type', value: 'x'.repeat(MIRROR_TYPE_MAX + 1) }]
  ])('a malformed act is refused and never guessed: %j', async (message) => {
    const { viewer, out, acts } = attached()
    viewer.handleMessage(message)
    await vi.waitFor(() => expect(replies(out)).toHaveLength(1))
    expect(replies(out)[0]).toMatchObject({ t: 'dom-refused', stage: 'act' })
    expect(acts).toEqual([])
  })

  it('a value is only kept for type', () => {
    expect(mirrorRequest({ t: 'dom-act', ref: 3, act: 'press', value: 'x' })).toEqual({ kind: 'act', command: { ref: 3, act: 'press' } })
  })

  it('past the queue, a request is refused in words', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<MirrorPage>((resolve) => {
      release = () => resolve(page('slow'))
    })
    const { viewer, out } = attached({ read: () => gate })
    for (let i = 0; i < MIRROR_QUEUE_MAX + 1; i += 1) viewer.handleMessage({ t: 'dom' })
    expect(replies(out)).toEqual([{ t: 'dom-refused', why: expect.any(String), stage: 'read' }])
    release()
    await vi.waitFor(() => expect(replies(out)).toHaveLength(MIRROR_QUEUE_MAX + 1))
  })

  it('a viewer that left gets no answer', async () => {
    const { viewer, out, reads } = attached()
    viewer.handleMessage({ t: 'dom' })
    viewer.close()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(replies(out)).toEqual([])
    expect(reads).toEqual([])
  })
})

describe('a mirror line holds its frames', () => {
  it('frames stop reaching a viewer that asked for none', () => {
    const { viewer, out, frameListeners } = attached()
    const push = (): void => {
      for (const listener of frameListeners) listener('/9j/AAAA', { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 })
    }
    push()
    expect(out.sent.filter((m) => m.t === 'frame')).toHaveLength(1)
    viewer.handleMessage({ t: 'frames', on: false })
    push()
    expect(out.sent.filter((m) => m.t === 'frame')).toHaveLength(1)
  })
})

describe('the reply on the line', () => {
  it('a page past the budget loses blocks from the end and says it was cut', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => ({ ref: i + 1, role: 'paragraph' as const, text: 'x'.repeat(100) }))
    const fitted = fitPage({ url: 'u', title: 't', blocks, truncated: false, pixelOnly: false }, 5_000)
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(5_000)
    expect(fitted.truncated).toBe(true)
    expect(fitted.blocks[0].ref).toBe(1)
    expect(fitted.blocks.length).toBeLessThan(200)
  })

  it('a page within it is passed as it is', () => {
    const small = page('small')
    expect(fitPage(small, 5_000)).toBe(small)
  })
})

describe('acting on a live tab', () => {
  function tab(send: MirrorTab['send']) {
    const listeners = new Map<string, Set<(p: Record<string, unknown>) => void>>()
    const emit = (event: string, params: Record<string, unknown>): void => {
      for (const listener of listeners.get(event) ?? []) listener(params)
    }
    const value: MirrorTab = {
      send,
      on: (event, listener) => void listeners.set(event, new Set([...(listeners.get(event) ?? []), listener])),
      off: (event, listener) => void listeners.get(event)?.delete(listener),
      evaluate: async () => []
    }
    return { value, emit, listeners }
  }

  it('reaches only the mirror CDP methods', async () => {
    const methods: string[] = []
    const t = tab(async (method) => {
      methods.push(method)
      return method === 'DOM.resolveNode' ? { object: { objectId: 'o1' } } : {}
    })
    await expect(actOnTab(t.value, { ref: 4, act: 'press' }, { settleMs: 0, loadWaitMs: 50 })).resolves.toEqual({ ok: true })
    expect(methods.every((method) => MIRROR_CDP.has(method))).toBe(true)
  })

  it('a press that starts a load waits for it to stop before the fresh read', async () => {
    let t: ReturnType<typeof tab> | null = null
    t = tab(async (method) => {
      if (method === 'Runtime.callFunctionOn') t?.emit('Page.frameStartedLoading', { frameId: 'main' })
      return method === 'DOM.resolveNode' ? { object: { objectId: 'o1' } } : {}
    })
    let done = false
    const acting = actOnTab(t.value, { ref: 4, act: 'press' }, { settleMs: 0, loadWaitMs: 5_000 }).then(() => {
      done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(done).toBe(false)
    t.emit('Page.frameStoppedLoading', { frameId: 'main' })
    await acting
    expect(done).toBe(true)
    expect(t.listeners.get('Page.frameStartedLoading')?.size ?? 0).toBe(0)
  })

  it('a load that never stops is waited for only so long', async () => {
    let t: ReturnType<typeof tab> | null = null
    t = tab(async (method) => {
      if (method === 'Runtime.callFunctionOn') t?.emit('Page.frameStartedLoading', { frameId: 'ad' })
      return method === 'DOM.resolveNode' ? { object: { objectId: 'o1' } } : {}
    })
    await expect(actOnTab(t.value, { ref: 4, act: 'press' }, { settleMs: 0, loadWaitMs: 30 })).resolves.toEqual({ ok: true })
  })
})
