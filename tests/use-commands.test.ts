// THE AGENT'S HAND ON A SCREEN CARD (main/use-commands.ts): each command's
// gesture, the cursor signal it mints, and the sentences it refuses with.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserInstance } from '../src/main/browser-instance'
import { SERVED_USE_REFUSED, handlesUseCommand, runUseCommand, servedUseRefusal, shotName, type UseCommandContext } from '../src/main/use-commands'
import type { Gesture } from '../src/main/vphone-input'
import type { UseSignal } from '../src/shared/use-signal'
import { parseUseUrl } from '../src/shared/use-url'

function screenCard(url = 'adb://default') {
  const acted: Gesture[][] = []
  const inputs: Array<[string, unknown]> = []
  const signals: UseSignal[] = []
  const instance = {
    viewport: { width: 400, height: 800 },
    status: { state: 'live', message: null, use: 'phone', input: true },
    act: async (g: readonly Gesture[]) => void acted.push([...g]),
    snapshot: async () => Buffer.from('jpegbytes').toString('base64'),
    dispatchInput: (m: string, p: unknown) => void inputs.push([m, p])
  } as unknown as BrowserInstance
  const shotsDir = mkdtempSync(path.join(tmpdir(), 'use-shots-'))
  const ctx: UseCommandContext = {
    agent: 'agent-1',
    card: 'card-1',
    cardName: 'Pixel 9',
    target: parseUseUrl(url),
    shotsDir,
    now: () => 42,
    emit: (s) => void signals.push(s)
  }
  return { instance, ctx, acted, inputs, signals }
}

describe('handlesUseCommand', () => {
  it('a screen card takes the screen verbs; a web card only the pointed ones and screenshot', () => {
    const { instance } = screenCard()
    expect(['tap', 'click', 'swipe', 'type', 'key', 'scroll', 'status', 'snapshot', 'screenshot'].every((v) => handlesUseCommand(v, instance))).toBe(true)
    const web = { ...instance, act: undefined } as unknown as BrowserInstance
    expect(handlesUseCommand('tap', web)).toBe(true)
    expect(handlesUseCommand('screenshot', web)).toBe(true)
    expect(handlesUseCommand('click', web)).toBe(false)
    expect(handlesUseCommand('type', web)).toBe(false)
  })
})

describe('runUseCommand', () => {
  it('tap: one gesture in points, and a cursor signal at the point', async () => {
    const { instance, ctx, acted, signals } = screenCard()
    expect(await runUseCommand('tap', ['120', '340'], instance, ctx)).toBe('Tapped (120, 340) on 400x800')
    expect(await runUseCommand('click', ['10,20'], instance, ctx)).toMatch(/Tapped \(10, 20\)/)
    expect(acted).toEqual([[{ method: 'input.tap', params: { x: 120, y: 340 } }], [{ method: 'input.tap', params: { x: 10, y: 20 } }]])
    expect(signals[0]).toEqual({ agent: 'agent-1', card: 'card-1', use: 'phone', verb: 'tap', point: { x: 120, y: 340 }, viewport: { width: 400, height: 800 }, at: 42 })
  })

  it('a point off the screen is refused with the screen’s size', async () => {
    const { instance, ctx, acted } = screenCard()
    await expect(runUseCommand('tap', ['500', '10'], instance, ctx)).rejects.toThrow(/outside the screen — it is 400x800 points/)
    await expect(runUseCommand('tap', ['x', '10'], instance, ctx)).rejects.toThrow(/x must be a number/)
    expect(acted).toEqual([])
  })

  it('swipe, type (ASCII typed, other text pasted), key, scroll', async () => {
    const { instance, ctx, acted } = screenCard()
    await runUseCommand('swipe', ['200', '700', '200', '100', '400'], instance, ctx)
    await runUseCommand('type', ['hello'], instance, ctx)
    await runUseCommand('type', ['你好'], instance, ctx)
    await runUseCommand('key', ['Enter'], instance, ctx)
    await runUseCommand('scroll', ['down', '300'], instance, ctx)
    expect(acted).toEqual([
      [{ method: 'input.swipe', params: { x1: 200, y1: 700, x2: 200, y2: 100, seconds: 0.4 } }],
      [{ method: 'input.type', params: { text: 'hello' } }],
      [{ method: 'input.paste', params: { text: '你好' } }],
      [{ method: 'input.key', params: { name: 'return' } }],
      [{ method: 'input.swipe', params: { x1: 200, y1: 400, x2: 200, y2: 100, seconds: 0.3 } }]
    ])
    await expect(runUseCommand('key', ['F13'], instance, ctx)).rejects.toThrow(/key takes Enter/)
  })

  it('on a computer card scroll is a wheel', async () => {
    const { instance, ctx, acted } = screenCard('screen://main')
    await runUseCommand('scroll', ['up', '120'], instance, ctx)
    expect(acted[0]).toEqual([{ method: 'input.scroll', params: { x: 200, y: 400, dx: 0, dy: -120 } }])
  })

  it('screenshot saves the frame and says the coordinate space', async () => {
    const { instance, ctx, signals } = screenCard()
    const out = await runUseCommand('screenshot', [], instance, ctx)
    const file = out.split('\n')[0]
    expect(file).toBe(path.join(ctx.shotsDir, 'pixel-9-42.jpg'))
    expect(readFileSync(file).toString()).toBe('jpegbytes')
    expect(out).toMatch(/screen: 400x800 points/)
    expect(signals.at(-1)?.verb).toBe('look')
  })

  it('says the size the look found, not the one the card had before it', async () => {
    const { instance, ctx } = screenCard()
    const card = { ...instance, viewport: { width: 800, height: 600 } }
    const look = vi.fn(async () => {
      card.viewport = { width: 1440, height: 900 }
      return Buffer.from('fresh').toString('base64')
    })
    const out = await runUseCommand('screenshot', [], Object.assign(card, { look }), ctx)
    expect(out).toContain('1440x900')
  })

  it('status asks the device before it answers', async () => {
    const { instance, ctx } = screenCard()
    const check = vi.fn(async () => undefined)
    await runUseCommand('status', [], { ...instance, check }, ctx)
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('a screen card is looked at for the screenshot, not read from what it last held', async () => {
    const { instance, ctx } = screenCard()
    const snapshot = vi.fn(async () => null)
    const look = vi.fn(async () => Buffer.from('fresh').toString('base64'))
    await runUseCommand('screenshot', [], { ...instance, snapshot, look }, ctx)
    expect(look).toHaveBeenCalledTimes(1)
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('status reads the device line; a screenshot with no frame says why', async () => {
    const { instance, ctx } = screenCard()
    const offline = { ...instance, status: { state: 'offline', message: 'No Android device is attached', use: 'phone', input: true }, snapshot: async () => null } as unknown as BrowserInstance
    expect(await runUseCommand('status', [], offline, ctx)).toBe('offline: No Android device is attached')
    await expect(runUseCommand('screenshot', [], offline, ctx)).rejects.toThrow(/no frame yet — No Android device is attached/)
  })

  it('a pointed tap on a web card is a real mouse click at the point', async () => {
    const { instance, ctx, inputs, signals } = screenCard()
    const web = { ...instance, act: undefined, status: undefined } as unknown as BrowserInstance
    await runUseCommand('tap', ['50', '60'], web, { ...ctx, target: null })
    expect(inputs.map(([, p]) => (p as { type: string }).type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(signals[0].use).toBe('browser')
  })
})

describe('screenshot names', () => {
  it('a caller picks a name, never a place', async () => {
    const ctx = { cardName: 'Pixel 9', now: () => 7 }
    expect(shotName(undefined, ctx)).toBe('pixel-9-7.jpg')
    expect(shotName('login', ctx)).toBe('login.jpg')
    expect(shotName('a.jpeg', ctx)).toBe('a.jpeg')
    for (const bad of ['../x.jpg', '/etc/x.jpg', 'a/b.jpg', '.zshrc', '~/x.jpg', 'a..b']) expect(() => shotName(bad, ctx), bad).toThrow(/plain file name/)
    const { instance, ctx: full } = screenCard()
    const out = await runUseCommand('screenshot', ['login'], instance, full)
    expect(out.split('\n')[0]).toBe(path.join(full.shotsDir, 'login.jpg'))
  })
})

describe('servedUseRefusal', () => {
  const cards: Record<string, string[]> = { Web: ['https://a.test'], Phone: ['adb://default'], Mixed: ['https://a.test', 'screen://main'] }
  const urls = (name: string) => cards[name] ?? []
  it('refuses a served caller every way onto a use, and nothing else', () => {
    expect(servedUseRefusal(['create', 'screen://main', 'D'], urls)).toBe(SERVED_USE_REFUSED)
    expect(servedUseRefusal(['create', 'https://x.test', 'Phone'], urls)).toBe(SERVED_USE_REFUSED)
    expect(servedUseRefusal(['navigate', 'Web', 'cam://0'], urls)).toBe(SERVED_USE_REFUSED)
    expect(servedUseRefusal(['tab-new', 'Web', 'window://1Password'], urls)).toBe(SERVED_USE_REFUSED)
    expect(servedUseRefusal(['screenshot', 'Phone'], urls)).toBe(SERVED_USE_REFUSED)
    expect(servedUseRefusal(['tab-select', 'Mixed', '2'], urls)).toBe(SERVED_USE_REFUSED)
    expect(servedUseRefusal(['create', 'https://x.test', 'New'], urls)).toBeNull()
    expect(servedUseRefusal(['click', 'Web', '@e1'], urls)).toBeNull()
    expect(servedUseRefusal(['navigate', 'Web', 'https://b.test'], urls)).toBeNull()
  })
})

