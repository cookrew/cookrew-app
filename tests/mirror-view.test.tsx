// A BROWSER CARD'S PAGE DRAWN ON THE VIEWER'S DEVICE (renderer/src/mirror/).
// Owner ruling 2026-11-23: a remote viewer sees the page LOCAL by default —
// drawn from data with real elements — and the screen stream is a button,
// never an automatic fallback.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MirrorView } from '../src/renderer/src/mirror/MirrorView'
import { headingTag, mirrorRows } from '../src/renderer/src/mirror/mirror-layout'
import { actMsg, parseMirrorMessage, parseMirrorPage } from '../src/renderer/src/mirror/mirror-message'
import { DEFAULT_REMOTE_BROWSER_MODE, chooseRemoteBrowserMode, remoteBrowserMode } from '../src/renderer/src/mirror/mirror-mode'
import { MIRROR_IDLE, nextMirror, type MirrorState } from '../src/renderer/src/mirror/mirror-state'
import { parseStreamObject } from '../src/renderer/src/browser-stream'
import type { MirrorPage } from '../src/shared/dom-mirror'

const MIRROR_DIR = path.join(__dirname, '../src/renderer/src/mirror')

const page: MirrorPage = {
  url: 'https://example.com/inbox',
  title: 'Inbox',
  blocks: [
    { ref: 1, role: 'heading', text: 'Inbox', level: 1 },
    { ref: 2, role: 'paragraph', text: 'Two new messages <script>alert(1)</script>' },
    { ref: 3, role: 'link', text: 'Docs', href: 'https://docs.example.com/a' },
    { ref: 4, role: 'button', text: 'Archive' },
    { ref: 5, role: 'field', text: 'Search', value: 'invoices' },
    { ref: 6, role: 'checkbox', text: 'Unread only', checked: true },
    { ref: 7, role: 'listitem', text: 'First' },
    { ref: 8, role: 'listitem', text: 'Second' },
    { ref: 9, role: 'separator', text: '' },
    { ref: 10, role: 'button', text: 'Delete', disabled: true }
  ],
  truncated: false,
  pixelOnly: false
}

const noop = (): void => undefined
const render = (state: MirrorState): string =>
  renderToStaticMarkup(<MirrorView state={state} onAct={noop} onScreen={noop} onReload={noop} onRetry={noop} />)
const ready = (over: Partial<MirrorPage> = {}, note: string | null = null): MirrorState => ({
  phase: 'ready',
  page: { ...page, ...over },
  busy: false,
  note
})

describe('the page, drawn here with real elements', () => {
  const html = render(ready())

  it('headings, paragraphs and list items are text in the right elements', () => {
    expect(html).toContain('<h2 class="mirror-heading">Inbox</h2>')
    expect(html).toContain('<ul class="mirror-list"><li class="mirror-text">First</li><li class="mirror-text">Second</li></ul>')
    expect(html).toContain('<hr class="mirror-rule"/>')
  })

  it("the page's text is drawn as text, never as markup", () => {
    expect(html).toContain('Two new messages &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('a link is a button that presses the page link: its address shown, never an href here', () => {
    expect(html).toMatch(/<button type="button" class="mirror-link"><span>Docs<\/span><span class="mirror-link-href">docs\.example\.com<\/span><\/button>/)
    expect(html).not.toContain('href=')
  })

  it('buttons, fields and checkboxes are real controls', () => {
    expect(html).toContain('<button type="button" class="mirror-button">Archive</button>')
    expect(html).toContain('<button type="button" class="mirror-button" disabled="">Delete</button>')
    expect(html).toMatch(/<span class="mirror-field-label">Search<\/span><input type="text" value="invoices"\/>/)
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span>Unread only<\/span>/)
  })

  it('the toolbar has the Screen button, and no picture is drawn', () => {
    expect(html).toContain('data-mirror-screen="true">Screen</button>')
    expect(html).not.toMatch(/<canvas|<img/)
    expect(html).toContain('data-mirror-state="ready"')
  })
})

describe('where the mirror cannot carry the page, it says so', () => {
  it('pixelOnly: words beside a Screen button, and the page it could read still shown', () => {
    const html = render(ready({ pixelOnly: true }))
    expect(html).toContain('is not shown here')
    expect(html).toContain('data-mirror-screen="true">Show the screen</button>')
    expect(html).toContain('Archive')
    expect(html).not.toMatch(/<canvas|<img/)
  })

  it('a failed read: the reason, the Screen button and a retry, never the stream', () => {
    const html = render({ phase: 'failed', why: 'The page could not be read just now.' })
    expect(html).toContain('The page could not be read just now.')
    expect(html).toContain('data-mirror-screen="true">Show the screen</button>')
    expect(html).toContain('Try again')
    expect(html).not.toMatch(/<canvas|<img/)
  })

  it('a cut page says it goes on; an empty one says it has nothing to show', () => {
    expect(render(ready({ truncated: true }))).toContain('The page goes on')
    expect(render(ready({ blocks: [] }))).toContain('no text or controls')
  })

  it('a refused act stands above the page it left as it was', () => {
    const html = render(ready({}, 'Take control of this card first.'))
    expect(html).toContain('Take control of this card first.')
    expect(html).toContain('Archive')
  })

  it('reading says so', () => {
    expect(render({ phase: 'reading' })).toContain('Reading the page')
  })
})

describe('the view state never chooses the screen', () => {
  const refused = (stage: 'read' | 'act') => ({ type: 'message' as const, message: { kind: 'dom-refused' as const, why: 'no', stage } })

  it('a refused read fails in words', () => {
    expect(nextMirror({ phase: 'reading' }, refused('read'))).toEqual({ phase: 'failed', why: 'no' })
  })

  it('a refused act keeps the page with its reason', () => {
    const state = ready()
    expect(nextMirror({ ...state, busy: true } as MirrorState, refused('act'))).toEqual({ ...state, note: 'no' })
  })

  it('a fresh page replaces the old one and clears the note', () => {
    const fresh = { ...page, title: 'Fresh' }
    expect(nextMirror(ready({}, 'old'), { type: 'message', message: { kind: 'dom', page: fresh } })).toEqual({ phase: 'ready', page: fresh, busy: false, note: null })
  })

  it('a lost line fails, and closing goes idle', () => {
    expect(nextMirror(ready(), { type: 'lost', why: 'gone' })).toEqual({ phase: 'failed', why: 'gone' })
    expect(nextMirror(ready(), { type: 'close' })).toBe(MIRROR_IDLE)
  })

  it('a remote card starts on Page, and only a choice moves it', () => {
    expect(DEFAULT_REMOTE_BROWSER_MODE).toBe('page')
    expect(remoteBrowserMode('card-a')).toBe('page')
    chooseRemoteBrowserMode('card-a', 'screen')
    expect(remoteBrowserMode('card-a')).toBe('screen')
    expect(remoteBrowserMode('card-b')).toBe('page')
  })
})

describe('a page off the line is read as untrusted data', () => {
  it('drops blocks with no ref or a role the mirror does not draw, and re-checks links', () => {
    const parsed = parseMirrorPage({
      url: 'u',
      title: 't',
      blocks: [
        { ref: 1, role: 'link', text: 'bad', href: 'javascript:alert(1)' },
        { ref: 2, role: 'script', text: 'x' },
        { role: 'button', text: 'no ref' },
        { ref: 3, role: 'heading', text: 'h', level: 99 }
      ],
      pixelOnly: 'yes'
    })
    expect(parsed?.blocks).toEqual([
      { ref: 1, role: 'link', text: 'bad' },
      { ref: 3, role: 'heading', text: 'h' }
    ])
    expect(parsed?.pixelOnly).toBe(false)
  })

  it('the stream parser hands dom messages to the mirror, typed', () => {
    expect(parseStreamObject({ t: 'dom', page })).toEqual({ kind: 'mirror', message: { kind: 'dom', page } })
    expect(parseStreamObject({ t: 'dom-refused', why: 'w', stage: 'act' })).toEqual({ kind: 'mirror', message: { kind: 'dom-refused', why: 'w', stage: 'act' } })
    expect(parseMirrorMessage({ t: 'dom', page: 'nope' })).toBeNull()
  })

  it('this device sends a ref and a verb, and text only to type', () => {
    expect(actMsg(4, 'press')).toEqual({ t: 'dom-act', ref: 4, act: 'press' })
    expect(actMsg(5, 'type', 'hi')).toEqual({ t: 'dom-act', ref: 5, act: 'type', value: 'hi' })
  })

  it('list items in a run share one list; headings sit below the card title', () => {
    expect(mirrorRows(page.blocks).filter((row) => row.kind === 'list')).toHaveLength(1)
    expect([headingTag(1), headingTag(2), headingTag(9), headingTag(undefined)]).toEqual(['h2', 'h3', 'h6', 'h3'])
  })
})

describe('source rules for the mirror view', () => {
  const files = readdirSync(MIRROR_DIR).filter((name) => /\.(ts|tsx)$/.test(name))
  const source = (name: string): string => readFileSync(path.join(MIRROR_DIR, name), 'utf8')

  it('never writes markup from a string', () => {
    expect(files.length).toBeGreaterThan(4)
    for (const name of files) {
      expect(source(name), name).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
    }
  })

  it('the page view and its line never reach for the stream', () => {
    // The switch itself (RemoteBrowserView) and the module that keeps the choice (mirror-mode) are the two exceptions.
    for (const name of files.filter((file) => file !== 'RemoteBrowserView.tsx' && file !== 'mirror-mode.ts')) {
      expect(source(name), name).not.toMatch(/MobileBrowserFrame|useBrowserStream|chooseRemoteBrowserMode/)
    }
  })

  it('the switch to the screen is a button press and nothing else', () => {
    const view = source('RemoteBrowserView.tsx')
    expect(view).not.toMatch(/useEffect|useLayoutEffect|setTimeout/)
    expect(view.match(/choose\('screen'\)/g)).toEqual(["choose('screen')"])
    expect(view).toContain("onScreen={() => choose('screen')}")
    expect(view.match(/choose\('page'\)/g)).toEqual(["choose('page')"])
    expect(view).toContain("onClick={() => choose('page')}")
  })

  it('remote web cards take the mirror; use cards and the desktop keep their view', () => {
    const layer = readFileSync(path.join(__dirname, '../src/renderer/src/BrowserLayer.tsx'), 'utf8')
    expect(layer).toContain("if (client === 'remote' && !vphone) {")
    expect(layer).toContain('<RemoteBrowserView')
  })
})
