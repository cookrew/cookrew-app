import {
  mirrorBlocks,
  pixelOnlyPage,
  safeHref,
  type MirrorBlock,
  type MirrorPage,
  type MirrorRole
} from '../shared/dom-mirror'

/**
 * READING A PAGE AND PRESSING ONE OF ITS ELEMENTS (main/dom-mirror.ts).
 *
 * Runs on the computer that holds the browser, over the CDP connection it
 * already has. The device only ever sends a REF and one of three verbs; no
 * caller supplies code, a selector, or a function. That is the whole security
 * argument: the page stays data going out, and the only thing coming back is
 * "press this one", "focus this one", "type into this one".
 *
 * The accessibility tree is read, not the DOM: it is what a screen reader gets,
 * already flattened, and it carries the names and roles a person reads. Each
 * node's backend id becomes the mirror's ref.
 */

export interface CdpSend {
  (method: string, params: Record<string, unknown>): Promise<unknown>
}

interface AxValue {
  readonly type?: string
  readonly value?: unknown
}

interface AxNode {
  readonly nodeId: string
  readonly ignored?: boolean
  readonly role?: AxValue
  readonly name?: AxValue
  readonly value?: AxValue
  readonly description?: AxValue
  readonly backendDOMNodeId?: number
  readonly properties?: ReadonlyArray<{ readonly name: string; readonly value?: AxValue }>
}

/** Roles worth drawing. Anything else is shape, not content. */
const ROLES: Readonly<Record<string, MirrorRole>> = {
  heading: 'heading',
  paragraph: 'paragraph',
  link: 'link',
  button: 'button',
  textbox: 'field',
  searchbox: 'field',
  combobox: 'select',
  listbox: 'select',
  checkbox: 'checkbox',
  radio: 'checkbox',
  listitem: 'listitem',
  image: 'image',
  separator: 'separator',
  StaticText: 'paragraph'
}

const textOf = (value: AxValue | undefined): string => (typeof value?.value === 'string' ? value.value : '')
const prop = (node: AxNode, name: string): unknown => node.properties?.find((p) => p.name === name)?.value?.value

function roleOf(node: AxNode): MirrorRole | null {
  const raw = textOf(node.role)
  return ROLES[raw] ?? null
}

/** One AX node as a block, or null when it carries nothing the mirror draws. */
export function blockOf(node: AxNode): MirrorBlock | null {
  if (node.ignored === true || node.backendDOMNodeId === undefined) return null
  const role = roleOf(node)
  if (role === null) return null
  const name = textOf(node.name)
  const value = textOf(node.value)
  // A paragraph and a field read differently: one says its text, the other what
  // is in it. A button's name is its label.
  const text = role === 'field' || role === 'select' ? name || value : name || (role === 'paragraph' ? value : '')
  const level = prop(node, 'level')
  const href = role === 'link' ? safeHref(textOf(node.description) || undefined) : undefined
  return {
    ref: node.backendDOMNodeId,
    role,
    text,
    ...(href === undefined ? {} : { href }),
    ...(role === 'field' || role === 'select' ? { value: value || undefined } : {}),
    ...(typeof level === 'number' ? { level } : {}),
    ...(prop(node, 'disabled') === true ? { disabled: true } : {}),
    ...(prop(node, 'checked') === 'true' || prop(node, 'checked') === true ? { checked: true } : {})
  }
}

/** The tags whose meaning the mirror cannot carry. A fixed expression of our own. */
const PIXEL_PROBE = `(() => Array.from(document.querySelectorAll('canvas,video,iframe,embed,object')).slice(0, 8).map((el) => el.tagName.toLowerCase()))()`

export interface MirrorDeps {
  readonly send: CdpSend
  /** A tab-level evaluate used only for the pixel probe; absent = assume nothing. */
  readonly probe?: () => Promise<string[]>
}

/**
 * The page as a mirror: reading order, elements by ref, and whether the screen
 * is still the better source. A failure is a thrown error: the caller says so
 * rather than drawing a page it could not read (cast-mirror.ts).
 */
export async function captureMirror(deps: MirrorDeps, url: string, title: string): Promise<MirrorPage> {
  const answer = (await deps.send('Accessibility.getFullAXTree', {})) as { nodes?: AxNode[] }
  const nodes = Array.isArray(answer?.nodes) ? answer.nodes : []
  const blocks: MirrorBlock[] = []
  for (const node of nodes) {
    const block = blockOf(node)
    if (block !== null) blocks.push(block)
  }
  const cleaned = mirrorBlocks(blocks)
  let pixelOnly = false
  try {
    const tags = deps.probe ? await deps.probe() : []
    pixelOnly = pixelOnlyPage(tags)
  } catch {
    // A probe that could not run is not evidence either way.
  }
  return { url, title, blocks: cleaned.blocks, truncated: cleaned.truncated, pixelOnly }
}

/** The verbs a mirror may ask for. Nothing else is accepted. */
export type MirrorAct = 'press' | 'focus' | 'type' | 'check'

const FUNCTIONS: Readonly<Record<MirrorAct, string>> = {
  press: 'function () { this.scrollIntoView({ block: "center", inline: "nearest" }); this.click(); }',
  focus: 'function () { this.focus(); }',
  // The value is set through the prototype's own setter, so a framework that
  // watches the field sees a person's change and not a silent assignment.
  type: `function (text) {
    const el = this;
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }`,
  check: 'function () { this.click(); }'
}

/** What a caller may say to `act`; the value only for `type`. */
export interface MirrorCommand {
  readonly ref: number
  readonly act: MirrorAct
  readonly value?: string
}

/**
 * Press, focus, type into, or check ONE element of the page, by the ref the
 * mirror gave. Refused: an act the mirror does not have, a ref that is not a
 * number, or an element CDP cannot resolve (a page that navigated since).
 */
export async function actOnMirror(deps: Pick<MirrorDeps, 'send'>, command: MirrorCommand): Promise<{ ok: true } | { ok: false; why: string }> {
  const fn = FUNCTIONS[command.act]
  if (typeof fn !== 'string') return { ok: false, why: 'Unknown action.' }
  if (!Number.isInteger(command.ref) || command.ref <= 0) return { ok: false, why: 'Unknown element.' }
  if (command.act === 'type' && typeof command.value !== 'string') return { ok: false, why: 'Nothing to type.' }
  let objectId: string
  try {
    const resolved = (await deps.send('DOM.resolveNode', { backendNodeId: command.ref })) as { object?: { objectId?: string } }
    const found = resolved?.object?.objectId
    if (typeof found !== 'string') return { ok: false, why: 'That element is gone.' }
    objectId = found
  } catch {
    return { ok: false, why: 'That element is gone.' }
  }
  try {
    await deps.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: fn,
      arguments: command.act === 'type' ? [{ value: command.value }] : [],
      returnByValue: true
    })
    return { ok: true }
  } catch {
    return { ok: false, why: 'The page did not answer.' }
  } finally {
    void deps.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

/**
 * THE ONLY CDP A MIRROR MAY REACH. The browser instance's own `send` is wide
 * on purpose (an agent drives the page); a request that arrives from another
 * device must not share that width. These four methods read a page and press
 * one element in it, and nothing here takes code from the caller: the only
 * expression that ever runs is `pixelProbe`'s, which is ours.
 */
export const MIRROR_CDP: ReadonlySet<string> = new Set([
  'Accessibility.getFullAXTree',
  'DOM.resolveNode',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject'
])

function allowlistedSend(send: CdpSend, allowed: ReadonlySet<string>, purpose: string): CdpSend {
  return async (method, params) => {
    if (!allowed.has(method)) throw new Error(`${method} is not part of ${purpose}`)
    return send(method, params)
  }
}

/** A tab's `send`, narrowed to the methods a mirror has any business with. */
export function mirrorSend(send: CdpSend): CdpSend {
  return allowlistedSend(send, MIRROR_CDP, 'a mirror')
}

const PROXY_COOKIE_CDP = new Set(['Network.getCookies'])

/** A proxy reads cookies for one URL in the card's own profile. */
export function readProxyCookies(send: CdpSend, url: string): Promise<unknown> {
  return allowlistedSend(send, PROXY_COOKIE_CDP, 'the web proxy')('Network.getCookies', { urls: [url] })
}

/** The fixed probe a live instance hands to `captureMirror`; it evaluates OUR string only. */
export const pixelProbe = (evaluate: (expression: string) => Promise<unknown>): (() => Promise<string[]>) => async () => {
  const answer = await evaluate(PIXEL_PROBE)
  return Array.isArray(answer) ? answer.filter((tag): tag is string => typeof tag === 'string') : []
}
