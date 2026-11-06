import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseUseUrl, type Use, type UseTarget } from '../shared/use-url'
import type { UsePoint, UseSignal } from '../shared/use-signal'
import type { BrowserInstance } from './browser-instance'
import { vphoneKeyName, type Gesture } from './vphone-input'
import { machineCopy } from '../shared/machine-words'

/**
 * THE AGENT'S HAND ON A SCREEN CARD (computer, phone, hardware use).
 *
 * A web card is driven through its DOM (headless-browser-command.ts). A
 * screen has no DOM — the agent looks at it and points:
 *
 *   cookrew browser screenshot "Card" [name.jpg]  the screen, saved under the shots folder; says the coordinate space
 *   cookrew browser tap "Card" X Y                a tap or click at viewport points
 *   cookrew browser swipe "Card" X1 Y1 X2 Y2 [ms] a swipe or drag
 *   cookrew browser type "Card" TEXT              typed into whatever has focus
 *   cookrew browser key "Card" Enter              Enter Backspace Tab Escape Space Arrow…
 *   cookrew browser scroll "Card" down [AMOUNT]   at the middle of the screen
 *   cookrew browser status "Card"                 live, or offline and why
 *
 * `tap`, `swipe` and `screenshot` work on a web card too — a pointed click
 * at a canvas app is sometimes the only click there is. Every acting
 * command mints a UseSignal with the point it acted at, which is the cursor
 * the owner watches move over the card.
 */

export interface UseCommandContext {
  readonly agent: string
  readonly card: string
  readonly cardName: string
  readonly target: UseTarget | null
  readonly shotsDir: string
  readonly now: () => number
  readonly emit: (signal: UseSignal) => void
}

const POINTED = new Set(['tap', 'swipe'])
const SCREEN_ONLY = new Set(['type', 'key', 'scroll', 'status', 'snapshot'])

/** Whether `sub` is answered here for this card (a screen card answers more than a web card does). */
export function handlesUseCommand(sub: string, instance: BrowserInstance): boolean {
  if (POINTED.has(sub) || sub === 'screenshot') return true
  return typeof instance.act === 'function' && (SCREEN_ONLY.has(sub) || sub === 'click')
}

const number = (raw: string | undefined, what: string): number => {
  const n = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n)) throw new Error(`${what} must be a number`)
  return n
}

/** `120 340` or `120,340` → a point inside the viewport. */
function pointFrom(params: readonly string[], at: number, viewport: { width: number; height: number }): { point: UsePoint; used: number } {
  const first = params[at] ?? ''
  const [xs, ys, used] = first.includes(',') ? [...first.split(','), 1] : [first, params[at + 1], 2]
  const x = number(String(xs), 'x')
  const y = number(ys === undefined ? undefined : String(ys), 'y')
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
    throw new Error(`(${x}, ${y}) is outside the screen — it is ${viewport.width}x${viewport.height} points; run screenshot to see it`)
  }
  return { point: { x, y }, used: Number(used) }
}

const useOf = (target: UseTarget | null): Use => target?.use ?? 'browser'

function signal(ctx: UseCommandContext, verb: string, point: UsePoint | null, viewport: { width: number; height: number }): void {
  ctx.emit({ agent: ctx.agent, card: ctx.card, use: useOf(ctx.target), verb, point, viewport: { ...viewport }, at: ctx.now() })
}

/** Press and release as the CDP literals every instance takes — what a web card's pointed click is. */
function mouseClick(instance: BrowserInstance, p: UsePoint): void {
  const base = { x: p.x, y: p.y, button: 'left', clickCount: 1 }
  instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
  instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

async function act(instance: BrowserInstance, gestures: Gesture[]): Promise<void> {
  if (!instance.act) throw new Error('this card is a web page: use click, fill and type with a selector from snapshot')
  await instance.act(gestures)
}

export async function runUseCommand(
  sub: string,
  params: readonly string[],
  instance: BrowserInstance,
  ctx: UseCommandContext
): Promise<string> {
  const viewport = instance.viewport
  const size = `${viewport.width}x${viewport.height}`
  switch (sub) {
    case 'status': {
      const status = instance.status
      if (!status) return 'live'
      return status.message ? `${status.state}: ${status.message}` : status.state
    }
    case 'screenshot':
    case 'snapshot': {
      const jpeg = await (instance.look?.() ?? instance.snapshot())
      if (!jpeg) {
        const why = instance.status?.message
        throw new Error(why ? `no frame yet — ${why}` : 'no frame yet; try again in a moment')
      }
      const file = path.join(ctx.shotsDir, shotName(sub === 'screenshot' ? params[0] : undefined, ctx))
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, Buffer.from(jpeg, 'base64'))
      signal(ctx, 'look', null, viewport)
      return `${file}\nscreen: ${size} points — tap, swipe and scroll take points in this space (the image may be larger; scale its pixels down to ${viewport.width} wide)`
    }
    case 'tap':
    case 'click': {
      const { point } = pointFrom(params, 0, viewport)
      signal(ctx, sub, point, viewport)
      if (instance.act) await act(instance, [{ method: 'input.tap', params: { x: Math.round(point.x), y: Math.round(point.y) } }])
      else mouseClick(instance, point)
      return `Tapped (${point.x}, ${point.y}) on ${size}`
    }
    case 'swipe': {
      const from = pointFrom(params, 0, viewport)
      const to = pointFrom(params, from.used, viewport)
      const msRaw = params[from.used + to.used]
      const ms = msRaw === undefined ? 300 : Math.min(Math.max(number(msRaw, 'ms'), 50), 5000)
      signal(ctx, 'swipe', to.point, viewport)
      if (instance.act) {
        await act(instance, [
          { method: 'input.swipe', params: { x1: Math.round(from.point.x), y1: Math.round(from.point.y), x2: Math.round(to.point.x), y2: Math.round(to.point.y), seconds: ms / 1000 } }
        ])
      } else {
        const press = { button: 'left', clickCount: 1 }
        instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.point.x, y: from.point.y, ...press })
        instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.point.x, y: to.point.y, button: 'left' })
        instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.point.x, y: to.point.y, ...press })
      }
      return `Swiped (${from.point.x}, ${from.point.y}) → (${to.point.x}, ${to.point.y}) in ${ms} ms`
    }
    case 'type': {
      const text = params[params.length - 1]
      if (!text) throw new Error(`Usage: cookrew browser type "${ctx.cardName}" TEXT`)
      signal(ctx, 'type', null, viewport)
      await act(instance, [{ method: /^[\x20-\x7e]+$/.test(text) ? 'input.type' : 'input.paste', params: { text } }])
      return `Typed ${text.length} characters`
    }
    case 'key': {
      const name = vphoneKeyName(params[0] ?? 'Enter')
      if (!name) throw new Error('key takes Enter, Backspace, Tab, Escape, Space or ArrowUp/Down/Left/Right')
      signal(ctx, 'key', null, viewport)
      await act(instance, [{ method: 'input.key', params: { name } }])
      return `Pressed ${params[0] ?? 'Enter'}`
    }
    case 'scroll': {
      const direction = params[0] ?? 'down'
      const amount = params[1] === undefined ? Math.round(viewport.height / 2) : number(params[1], 'amount')
      const center = { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) }
      const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0
      const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0
      if (dx === 0 && dy === 0) throw new Error('scroll takes up, down, left or right')
      signal(ctx, 'scroll', center, viewport)
      const gesture: Gesture =
        ctx.target?.use === 'computer'
          ? { method: 'input.scroll', params: { ...center, dx, dy } }
          : {
              method: 'input.swipe',
              params: { x1: center.x, y1: center.y, x2: center.x - dx, y2: Math.min(Math.max(center.y - dy, 0), viewport.height), seconds: 0.3 }
            }
      await act(instance, [gesture])
      return `Scrolled ${direction} ${amount}`
    }
    default:
      throw new Error(`Unknown browser command '${sub}'`)
  }
}

/**
 * The file a screenshot goes to: ALWAYS inside the shots folder. Main writes
 * it, outside any sandbox, so a path from the caller would be a write
 * anywhere the owner can write — a name is all a caller chooses.
 */
export function shotName(requested: string | undefined, ctx: Pick<UseCommandContext, 'cardName' | 'now'>): string {
  if (requested === undefined || requested === '') return `${slug(ctx.cardName)}-${ctx.now()}.jpg`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(requested) || requested.includes('..')) {
    throw new Error('screenshot takes a plain file name (letters, digits, . _ -); it is saved in the shots folder and the path is printed')
  }
  return /\.jpe?g$/i.test(requested) ? requested : `${requested}.jpg`
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'card'

export const SERVED_USE_REFUSED =
  `A served session cannot use ${machineCopy('this Mac', process.platform)}'s screens, cameras or phones — those belong to the owner, not to a caller`

/**
 * THE SERVED-SESSION GATE FOR USES (required, like the secrets gate).
 *
 * A served pane runs a CALLER's work under Seatbelt; the uses run in main,
 * outside it, with the owner's own grants — Screen Recording, the camera,
 * the attached phone, and with the machine switch on, the keyboard. So a
 * served caller may not create or navigate a card to a use address, nor
 * touch a card any of whose tabs is one (a tab switch would make it one).
 * `cardUrls` answers a card's tab addresses by name, or [] for no card.
 * `sources` is the picker (use-source-service.ts): the list of what is on the
 * owner's screen is refused outright, whatever it is asked with.
 */
export function servedUseRefusal(args: readonly string[], cardUrls: (name: string) => readonly string[]): string | null {
  const [sub, first, second] = args
  if (sub === 'sources') return SERVED_USE_REFUSED
  const addresses = sub === 'create' ? [first] : sub === 'navigate' || sub === 'tab-new' ? [second] : []
  const card = sub === 'create' ? second : first
  const all = [...addresses, ...(card ? cardUrls(card) : [])]
  return all.some((url) => typeof url === 'string' && parseUseUrl(url) !== null) ? SERVED_USE_REFUSED : null
}

