/**
 * A DOM SMALL ENOUGH TO READ, REAL ENOUGH TO CATCH THIS CLASS OF BUG.
 *
 * The site's scripts are browser files with no build step, and the sheet's
 * markup is a string in site-shell.ts. The existing harness stubs
 * `getElementById` with a Map that invents a node for any id ever asked for —
 * which is enough for "did the dialog open", and is exactly why real-UI QA
 * found a screen writing its refusal into a node that was no longer in the
 * document. A Map cannot tell you that.
 *
 * So this is a tree: children have parents, `replaceChildren` DETACHES what it
 * replaces, and `getElementById` walks from the root — a detached node is not
 * found, which is the whole property under test. Everything else is the
 * smallest surface site.js and factors.js actually touch.
 */

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])

type Listener = (event: MiniEvent) => void

export interface MiniEvent {
  type: string
  target: El
  key?: string
  preventDefault: () => void
  defaultPrevented: boolean
}

export class El {
  readonly tag: string
  readonly dataset: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}
  readonly children: El[] = []
  parent: El | null = null
  className = ''
  value = ''
  disabled = false
  hidden = false
  readOnly = false
  placeholder = ''
  open = false
  focused = 0
  /** Set on a dialog by showModal, cleared by close — as the real one is. */
  modals = 0
  private text = ''
  private readonly listeners = new Map<string, Listener[]>()
  private readonly doc: MiniDocument

  constructor(tag: string, doc: MiniDocument) {
    this.tag = tag.toLowerCase()
    this.doc = doc
  }

  get id(): string {
    return this.attributes.id ?? ''
  }
  set id(value: string) {
    this.attributes.id = value
  }

  /** The text of this node and everything under it, and setting it wipes both. */
  get textContent(): string {
    return this.children.length === 0 ? this.text : this.children.map((c) => c.textContent).join('')
  }
  set textContent(value: string) {
    this.children.splice(0).forEach((c) => (c.parent = null))
    this.text = value
  }

  get isConnected(): boolean {
    let at: El | null = this
    while (at !== null) {
      if (at === this.doc.root) return true
      at = at.parent
    }
    return false
  }

  /** The three verbs the scripts use, over the same string as `className`. */
  get classList(): {
    add: (name: string) => void
    remove: (name: string) => void
    toggle: (name: string, on?: boolean) => void
    contains: (name: string) => boolean
  } {
    const names = (): string[] => this.className.split(/\s+/).filter(Boolean)
    const write = (list: string[]): void => {
      this.className = list.join(' ')
    }
    return {
      add: (name) => write([...new Set([...names(), name])]),
      remove: (name) => write(names().filter((n) => n !== name)),
      toggle: (name, on) => {
        const wanted = on ?? !names().includes(name)
        write(wanted ? [...new Set([...names(), name])] : names().filter((n) => n !== name))
      },
      contains: (name) => names().includes(name)
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value
    if (name === 'class') this.className = value
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  append(...nodes: El[]): void {
    for (const node of nodes) {
      node.parent?.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = this
      this.children.push(node)
    }
    if (nodes.length > 0) this.text = ''
  }

  /** DETACHES what it replaces — the behaviour this file exists to model. */
  replaceChildren(...nodes: El[]): void {
    for (const held of this.children.splice(0)) held.parent = null
    this.text = ''
    this.append(...nodes)
  }

  after(...nodes: El[]): void {
    const holder = this.parent
    if (holder === null) return
    for (const node of nodes) node.parent?.children.splice(node.parent.children.indexOf(node), 1)
    const at = holder.children.indexOf(this)
    holder.children.splice(at + 1, 0, ...nodes)
    for (const node of nodes) node.parent = holder
  }

  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }

  matches(selector: string): boolean {
    return selector
      .split(',')
      .map((s) => s.trim())
      .some((one) => {
        if (one.startsWith('#')) return this.id === one.slice(1)
        if (one.startsWith('.')) return this.className.split(/\s+/).includes(one.slice(1))
        if (one.startsWith('[') && one.endsWith(']')) {
          // Attributes and `dataset` are two windows on one thing: a script
          // that writes `node.dataset.addTotp = '1'` must be found by
          // `[data-add-totp]`, which is how every handler in site.js reads.
          const name = one.slice(1, -1)
          return (
            this.attributes[name] !== undefined ||
            (name.startsWith('data-') && this.dataset[camel(name.slice(5))] !== undefined)
          )
        }
        return this.tag === one.toLowerCase()
      })
  }

  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): El[] {
    const found: El[] = []
    const walk = (node: El): void => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  closest(selector: string): El | null {
    let at: El | null = this
    while (at !== null) {
      if (at.matches(selector)) return at
      at = at.parent
    }
    return null
  }

  addEventListener(type: string, handler: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler])
  }

  handlersFor(type: string): Listener[] {
    return this.listeners.get(type) ?? []
  }

  focus(): void {
    this.focused += 1
  }
  showModal(): void {
    this.open = true
    this.modals += 1
  }
  close(): void {
    this.open = false
    this.dispatch('close')
  }

  /** Bubbles: this node, then its parents, then the document. */
  dispatch(type: string, extra: { key?: string } = {}): MiniEvent {
    const event: MiniEvent = {
      type,
      target: this,
      key: extra.key,
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true
      }
    }
    let at: El | null = this
    while (at !== null) {
      for (const handler of at.handlersFor(type)) handler(event)
      at = at.parent
    }
    for (const handler of this.doc.handlersFor(type)) handler(event)
    return event
  }
}

const camel = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

export class MiniDocument {
  readonly root: El
  cookie = ''
  visibilityState = 'visible'
  readonly body: El
  private readonly listeners = new Map<string, Listener[]>()

  constructor() {
    this.root = new El('html', this)
    this.body = new El('body', this)
    this.root.append(this.body)
  }

  createElement(tag: string): El {
    return new El(tag, this)
  }

  /** From the ROOT. A node that was replaced away is not found — the point. */
  getElementById(id: string): El | null {
    const found = (node: El): El | null => {
      for (const child of node.children) {
        if (child.id === id) return child
        const deeper = found(child)
        if (deeper !== null) return deeper
      }
      return null
    }
    return found(this.root)
  }

  querySelector(selector: string): El | null {
    return this.root.querySelector(selector)
  }
  querySelectorAll(selector: string): El[] {
    return this.root.querySelectorAll(selector)
  }

  addEventListener(type: string, handler: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler])
  }
  handlersFor(type: string): Listener[] {
    return this.listeners.get(type) ?? []
  }
}

/**
 * Enough of an HTML parser for the markup the registry actually writes:
 * tags, double-quoted attributes, boolean attributes, void elements and text.
 * Anything cleverer would be a second implementation of a browser, and the
 * point is to run the REAL sheet rather than a hand-copied idea of it.
 */
export function parseHtml(html: string, doc: MiniDocument): El[] {
  const out: El[] = []
  const stack: El[] = []
  const attach = (node: El): void => {
    if (stack.length === 0) out.push(node)
    else stack[stack.length - 1].append(node)
  }
  let at = 0
  while (at < html.length) {
    const next = html.indexOf('<', at)
    if (next < 0) break
    const text = html.slice(at, next).trim()
    if (text !== '' && stack.length > 0) {
      const holder = stack[stack.length - 1]
      if (holder.children.length === 0) holder.textContent = text
    }
    const end = html.indexOf('>', next)
    if (end < 0) break
    const raw = html.slice(next + 1, end)
    at = end + 1
    if (raw.startsWith('/')) {
      stack.pop()
      continue
    }
    const name = /^[a-zA-Z0-9-]+/.exec(raw)?.[0] ?? ''
    const node = doc.createElement(name)
    for (const [, key, quoted, bare] of raw.slice(name.length).matchAll(
      /([a-zA-Z-]+)(?:="([^"]*)"|(?=\s|$))/g
    ) as IterableIterator<RegExpMatchArray>) {
      node.setAttribute(key, quoted ?? bare ?? '')
    }
    attach(node)
    if (!VOID.has(node.tag) && !raw.endsWith('/')) stack.push(node)
  }
  return out
}
