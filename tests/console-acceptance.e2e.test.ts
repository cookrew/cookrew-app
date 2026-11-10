import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client, bearer } from './support/auth-site-harness'
import { DESKTOP, PHONE, launchBrowser, type Browser, type Problem, type Tab, type Viewport } from './support/chrome-driver'
import { ADA, KITCHEN } from './support/console-machine'
import { bootConsoleStage, type ConsoleStage } from './support/console-stage'

/**
 * THE CONSOLE, ACCEPTED IN A REAL BROWSER, UNDER ITS OWN POLICY.
 *
 * Everything else about the console is proven in node. This is the one place
 * the built page is loaded by headless Chrome from a stand-in for its static
 * host, with the Content-Security-Policy the build wrote, against a real
 * registry split over its hosts and three machines of one account holding
 * real lines to it (support/console-stage.ts). The page is driven by input,
 * as a person drives it, at a phone's width and a desktop's.
 *
 * ANY REFUSED POLICY DIRECTIVE FAILS THE RUN. Every other thing a page got
 * wrong (an error on the console, an unanswered request) fails it too unless
 * it is one of the few this stage is known to cause, each named below with
 * its reason.
 *
 * AT A PHONE'S WIDTH nothing may be wider than the screen on any level, and
 * the console's own controls a finger goes for are at least 40 px tall
 * (`fits`). Inside a machine the controls are the app's own, as a phone has
 * always had them, and only the width is held here.
 *
 * NOT EXERCISED, because this stage cannot: a passkey (the gate is opened by
 * the password, on the auth host), a machine that answers a WebRTC offer or
 * has a name on the network (the fixture offers neither, so the path stays on
 * the relay), and any browser but Chrome.
 *
 * GATED (COOKREW_CONSOLE_E2E=1). It builds the console twice, launches Chrome
 * and takes about a minute per width: too heavy for every default run, where
 * four suites share the machine and a browser is one more thing to leak.
 *
 *   COOKREW_CONSOLE_E2E=1 npx vitest run tests/console-acceptance.e2e.test.ts
 *   COOKREW_CONSOLE_E2E_SHOTS=<dir>   keep the screenshots there (default: a temp dir, removed)
 */

const armed = process.env.COOKREW_CONSOLE_E2E === '1'
const suite = armed ? describe : describe.skip

const keptShots = process.env.COOKREW_CONSOLE_E2E_SHOTS
const shots = keptShots ?? (armed ? mkdtempSync(path.join(tmpdir(), 'cookrew-console-acceptance-')) : '')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const MINUTE = 60_000

/**
 * WHAT THIS STAGE IS KNOWN TO CAUSE, and why each is not the page's fault.
 * Matched against a problem's text; anything that matches nothing fails the step.
 */
const EXPLAINED: readonly { readonly why: string; readonly match: RegExp }[] = [
  { why: 'the registry asks a browser it has not seen for a second step: its 401 to the password is that question', match: /^401 POST http:\/\/auth\.localhost:\d+\/v2\/sessions$/ },
  { why: 'the fixture machine offers no direct link: the desktop answers a WebRTC offer it cannot take with 503', match: /^503 POST .*\/api\/rtc\/offer$/ },
  { why: 'the fixture machine has no screen to share: the desktop’s own route says 503', match: /^503 GET .*\/api\/use\/sources\/access/ },
  { why: 'a machine off its line: the relay answers 503 for it', match: /^503 GET .*\/api\/m\/[0-9a-f-]+\/api\/fleet/ },
  { why: 'the static host was stopped on purpose: the page asks it which build is out and gets no answer', match: /net::ERR_CONNECTION_REFUSED .*console\.localhost:\d+\/(version\.json|sw\.js)/ },
  { why: 'the static host was stopped on purpose (the console’s own report of the same)', match: /(version\.json|sw\.js).*(Failed to fetch|ERR_CONNECTION_REFUSED)|Failed to fetch.*(version\.json|sw\.js)/ },
  { why: 'signing out asks the registry, with the device key, whether the sign-in is really over: its 401 is the yes', match: /^401 POST http:\/\/api\.localhost:\d+\/v2\/sessions\/renew$/ },
  { why: 'a session that ended is refused once before it is renewed', match: /^401 (GET|POST) http:\/\/api\.localhost:\d+\/(v2\/me\/|api\/m\/)/ }
]

interface Seen {
  readonly step: string
  readonly width: number
  readonly problem: Problem
  readonly why: string | null
}

suite.each([
  ['phone', PHONE],
  ['desktop', DESKTOP]
] as const)('the console in a real browser, at a %s’s width', (name, viewport: Viewport) => {
  let stage: ConsoleStage
  let browser: Browser
  let tab: Tab
  /** A second tab of the same profile: the cold link, and the tab that did not press Update. */
  let other: Tab
  const seen: Seen[] = []
  const counted = new WeakMap<Tab, number>()
  const passed = new Set<number>()
  const origin = (): string => stage.host.origin

  const shot = (from: Tab, label: string): Promise<void> => from.shot(path.join(shots, `${name}-${label}.png`))

  /** What went wrong on a tab since it was last looked at: a refused directive fails, so does anything unexplained. */
  const settle = (step: string, ...tabs: Tab[]): void => {
    const fresh: Seen[] = []
    for (const one of tabs) {
      const from = counted.get(one) ?? 0
      counted.set(one, one.problems.length)
      for (const problem of one.problems.slice(from)) {
        fresh.push({ step, width: viewport.width, problem, why: problem.kind === 'csp' ? null : (EXPLAINED.find((known) => known.match.test(problem.text))?.why ?? null) })
      }
    }
    seen.push(...fresh)
    const refused = fresh.filter((one) => one.problem.kind === 'csp')
    expect(refused.map((one) => `${one.problem.text} (on ${one.problem.page})`), `the policy refused something during ${step}`).toEqual([])
    const unexplained = fresh.filter((one) => one.why === null)
    expect(unexplained.map((one) => `${one.problem.kind}: ${one.problem.text}`), `something went wrong on the page during ${step}`).toEqual([])
  }

  const needs = (...steps: number[]): void => {
    const missing = steps.filter((step) => !passed.has(step))
    if (missing.length > 0) throw new Error(`step ${missing.join(', ')} did not pass, and this one stands on it`)
  }

  const onConsole = (from: Tab, pathname: string | RegExp, why: string, ms = 20_000): Promise<unknown> => {
    const at = pathname instanceof RegExp ? `${pathname.toString()}.test(location.pathname + location.search)` : `(location.pathname + location.search) === ${JSON.stringify(pathname)}`
    return from.until(`location.origin === ${JSON.stringify(origin())} && ${at}`, why, ms)
  }

  /** Nothing wider than the screen, and the controls a finger goes for are tall enough for one. */
  const fits = async (from: Tab, where: string, primary: readonly string[]): Promise<void> => {
    if (!viewport.mobile) return
    const page = await from.evaluate<{ scroll: number; inner: number }>('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })')
    expect(page.scroll, `${where} is wider than the phone`).toBeLessThanOrEqual(page.inner)
    for (const selector of primary) {
      const box = await from.box(selector)
      expect(box, `${where}: ${selector} is on screen`).not.toBeNull()
      expect(Math.round(box?.height ?? 0), `${where}: ${selector} is too short for a finger`).toBeGreaterThanOrEqual(40)
    }
  }

  const terminal = (from: Tab): Promise<{ rows: number; text: string; colours: string[]; cursors: string[] }> =>
    from.evaluate(`(() => {
      const spans = [...document.querySelectorAll('.xterm-rows span')]
      return {
        rows: document.querySelectorAll('.xterm-rows > div').length,
        text: (document.querySelector('.xterm-rows') || { innerText: '' }).innerText,
        colours: [...new Set(spans.map((span) => getComputedStyle(span).color + ' on ' + getComputedStyle(span).backgroundColor))],
        cursors: [...document.querySelectorAll('.xterm-cursor')].map((cursor) => cursor.className + ' ' + getComputedStyle(cursor).backgroundColor)
      }
    })()`)

  /** The agent's card to its full view, and the full view to the live terminal. */
  const openTerminal = async (from: Tab): Promise<void> => {
    await from.click('.zv-av', 'Ada')
    await from.until(`document.querySelector('.cr-look-toggle')`, 'Ada’s full view')
    // One toggle says what is showing and a press flips it: chat, log, live.
    for (let press = 0; press < 3; press += 1) {
      if (await from.evaluate<boolean>(`!!document.querySelector('.cr-look-toggle.look-live')`)) break
      await from.click('.cr-look-toggle')
      await sleep(400)
    }
    await from.until(`document.querySelector('.cr-look-toggle.look-live') && document.querySelectorAll('.xterm-rows > div').length > 0 && /acceptance stage/.test(document.querySelector('.xterm-rows').innerText)`, 'the live terminal to draw what the machine sent', 30_000)
  }

  /** Behind another tab and back: what a phone does when its person looks away and returns. */
  const awayAndBack = async (from: Tab, away: Tab, between: () => Promise<void> = async () => undefined): Promise<void> => {
    await away.front()
    await from.until(`document.visibilityState === 'hidden'`, 'the tab to be in the background')
    await between()
    await from.front()
    await from.until(`document.visibilityState === 'visible'`, 'the tab to be in front again')
  }

  const storage = (from: Tab): Promise<{ local: string[]; session: string[]; indexed: { name: string; stores: string[] }[]; caches: string[] }> =>
    from.evaluate(`(async () => {
      const names = (await indexedDB.databases()).map((db) => db.name).filter(Boolean)
      const indexed = []
      for (const name of names) {
        const stores = await new Promise((resolve) => {
          const open = indexedDB.open(name)
          open.onsuccess = () => { const list = [...open.result.objectStoreNames]; open.result.close(); resolve(list) }
          open.onerror = () => resolve([])
        })
        indexed.push({ name, stores })
      }
      return { local: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage).sort(), indexed, caches: await caches.keys() }
    })()`)

  beforeAll(async () => {
    mkdirSync(shots, { recursive: true })
    stage = await bootConsoleStage()
    browser = await launchBrowser()
    tab = await browser.open(viewport, stage.clock.offset())
  }, 5 * MINUTE)

  afterAll(async () => {
    if (keptShots !== undefined && existsSync(shots)) {
      writeFileSync(
        path.join(shots, `${name}-problems.json`),
        JSON.stringify({ width: viewport.width, seen: seen.map((one) => ({ step: one.step, kind: one.problem.kind, text: one.problem.text, why: one.why })), unanswered: stage ? { studio: stage.studio.unanswered, laptop: stage.laptop.unanswered, old: stage.old.unanswered } : null }, null, 1)
      )
    }
    await browser?.close().catch(() => undefined)
    await stage?.close().catch(() => undefined)
    if (keptShots === undefined && name === 'desktop') rmSync(shots, { recursive: true, force: true })
  }, 2 * MINUTE)

  it('1. signed out it shows the way in; signing in happens on the auth host and ends back here, signed in, at a clean address', async () => {
    await tab.goto(`${origin()}/`)
    await tab.until(`document.querySelector('.cd-signin .cd-primary')`, 'the sign-in view')
    expect(await tab.text()).toContain('Your machines and their agents, from any browser.')
    await fits(tab, 'Sign-in', ['.cd-primary'])
    await shot(tab, '1a-signed-out')

    await tab.click('.cd-primary', 'Sign in')
    await tab.until(`location.origin === ${JSON.stringify(stage.site.A)} && document.querySelector('input[name=password]')`, 'the sign-in page on the auth host')
    await shot(tab, '1b-auth-host')
    await tab.click('input[name=username]')
    await tab.type(stage.username)
    await tab.click('input[name=password]')
    await tab.type(stage.password)
    await tab.key('Enter')

    // A browser the account has not seen: the first machine is asked, and its person types the number this page shows.
    await tab.click('button.rung', 'Approve on another device')
    const match = await tab.until<string>(`(document.body.innerText.match(/(\\d{2,})\\s+TYPE THIS NUMBER/i) || [])[1]`, 'the number to type on the other device')
    await shot(tab, '1c-approval-number')
    const deadline = Date.now() + 15_000
    while (!(await stage.approveSignIn(match))) {
      if (Date.now() > deadline) throw new Error('the sign-in never reached the first machine for approval')
      await sleep(200)
    }

    await onConsole(tab, '/', 'the console, signed in, at a clean address', 30_000)
    await tab.until(`document.querySelector('.cd-user') && document.querySelector('.cd-user').innerText === '@${stage.username}'`, 'the account’s name on the page')
    // The code on the way back is in no address and no storage after it was read.
    expect(await tab.url()).toBe(`${origin()}/`)
    const kept = await storage(tab)
    expect(kept.local).toEqual(['cr_console_session'])
    expect(kept.session).toEqual([])
    await shot(tab, '1d-signed-in')
    settle('step 1', tab)
    passed.add(1)
  }, 3 * MINUTE)

  it('2. the gate opens by the password, typed on the auth host; the machines are drawn as machines, the old one says to update and an offline one says so', async () => {
    needs(1)
    await tab.until(`document.querySelector('.cd-gate .cd-primary')`, 'the gate, asking for proof')
    expect(await tab.text()).toContain('Prove it’s you once to see inside your machines')
    // Before the gate: names and lines only, and nothing asked of any machine.
    expect(await tab.evaluate<number>(`document.querySelectorAll('.cd-tile').length`)).toBe(3)
    expect(stage.studio.requests.length + stage.laptop.requests.length + stage.old.requests.length).toBe(0)
    await fits(tab, 'the gate', ['.cd-gate .cd-primary'])
    await shot(tab, '2a-gate')

    await tab.click('.cd-gate .cd-primary', 'Use the account password')
    await tab.until(`location.origin === ${JSON.stringify(stage.site.A)} && document.querySelector('input[name=password]') && /OPEN YOUR MACHINES/i.test(document.body.innerText)`, 'the password page on the auth host')
    await shot(tab, '2b-auth-host-password')
    await tab.click('input[name=password]')
    await tab.type(stage.password)
    await tab.key('Enter')
    await onConsole(tab, '/', 'the console, with the pass', 30_000)

    // Past the gate each machine it can read lights with its own workspaces.
    await tab.until(`document.querySelectorAll('.cd-tile[data-standing=live]').length === 2`, 'the two machines it can read to answer', 30_000)
    const tiles = await tab.evaluate<{ name: string; standing: string; frame: boolean; say: string; disabled: boolean; chips: number }[]>(`[...document.querySelectorAll('.cd-tile')].map((tile) => ({
      name: tile.querySelector('.cd-label b').firstChild.textContent,
      standing: tile.dataset.standing,
      frame: !!tile.querySelector('.cd-frame .cd-screen') && !!tile.querySelector('.cd-deck'),
      say: (tile.querySelector('.cd-label em') || { innerText: '' }).innerText,
      disabled: tile.querySelector('.cd-open').disabled,
      chips: tile.querySelectorAll('.cd-ws').length
    }))`)
    expect(tiles.map((tile) => tile.name).sort()).toEqual(['Attic Mac', 'Road Laptop', 'Studio Mac'])
    expect(tiles.every((tile) => tile.frame)).toBe(true)
    const old = tiles.find((tile) => tile.name === 'Attic Mac')
    expect(old).toMatchObject({ standing: 'outdated', say: 'Update Cookrew on Attic Mac.', disabled: true, chips: 0 })
    expect(tiles.find((tile) => tile.name === 'Studio Mac')).toMatchObject({ standing: 'live', disabled: false, chips: 2 })
    // The Devices level asks nothing of a machine it will not read.
    expect(stage.old.requests).toEqual([])
    // Pressing the old machine goes nowhere.
    const oldBox = await tab.box('.cd-tile[data-standing=outdated] .cd-frame')
    await tab.clickAt((oldBox?.x ?? 0) + 8, (oldBox?.y ?? 0) + 8)
    await sleep(500)
    expect(await tab.url()).toBe(`${origin()}/`)
    // The two quiet links in the head are controls too: the way to the account, and the way out.
    await fits(tab, 'Devices', ['.cd-tile[data-standing=live] .cd-open', '.cd-head a.cd-quiet', '.cd-head button.cd-quiet'])
    await shot(tab, '2c-devices')

    // A machine that lets go of its line while the page is up says so within a few seconds, by itself:
    // its next summary is the relay's "no line", and the registry is asked at once (not at the next minute).
    await stage.laptop.offline()
    await tab.until(`document.querySelector('.cd-tile[data-standing=offline]')`, 'the machine off its line to say so', 20_000)
    const off = await tab.evaluate<{ text: string; disabled: boolean }>(`(() => { const tile = document.querySelector('.cd-tile[data-standing=offline]'); return { text: tile.querySelector('.cd-label').innerText, disabled: tile.querySelector('.cd-open').disabled } })()`)
    expect(off.text).toContain('Road Laptop')
    expect(off.text).toContain('offline')
    expect(off.text).toContain('Open Cookrew on Road Laptop.')
    expect(off.disabled).toBe(true)
    await tab.until(`document.querySelectorAll('.cd-tile[data-standing=live]').length === 1`, 'the machine still on its line to answer')
    await shot(tab, '2d-one-offline')
    await stage.laptop.online()
    settle('step 2', tab)
    passed.add(2)
  }, 3 * MINUTE)

  it('3. a machine is entered in place: its workspaces, an agent’s card, its terminal with colours and a cursor, and a prompt that arrives once', async () => {
    needs(2)
    const id = stage.studio.deviceId
    await tab.click('.cd-tile[data-standing=live] .cd-open', 'Open Studio Mac')
    await onConsole(tab, `/d/${id}`, 'the address of the machine')
    await tab.until(`document.querySelector('.zv-door[aria-label^="Open Kitchen agents"]') && document.querySelector('.zv-door[aria-label^="Open Garden agents"]')`, 'the machine’s workspaces', 30_000)
    await sleep(600)
    await fits(tab, 'a machine', [])
    await shot(tab, '3a-machine')

    await tab.click('.zv-door.agents', 'Open Kitchen agents')
    await onConsole(tab, `/d/${id}/w/${KITCHEN}`, 'the address of the workspace')
    await tab.until(`[...document.querySelectorAll('.zv-av')].some((el) => /^Ada,/.test(el.getAttribute('aria-label') || '')) && [...document.querySelectorAll('.zv-av')].some((el) => /^Basil,/.test(el.getAttribute('aria-label') || ''))`, 'the workspace’s agents')
    await sleep(600)
    await fits(tab, 'a workspace', [])
    await shot(tab, '3b-workspace')

    await tab.click('.zv-av', 'Ada')
    await onConsole(tab, `/d/${id}/w/${KITCHEN}/a/${ADA}`, 'the address of the agent')
    await tab.until(`/Plate the invented special/.test(document.body.innerText)`, 'the agent’s card')
    await sleep(600)
    await fits(tab, 'a card', [])
    await shot(tab, '3c-card')

    await openTerminal(tab)
    // The cursor is drawn once the terminal has been touched (xterm draws none before its first focus).
    await tab.click('.xterm-screen')
    await tab.until(`document.querySelector('.xterm-cursor')`, 'the terminal’s cursor')
    const drawn = await terminal(tab)
    // As many rows as its pane holds (a terminal somebody touched takes its pane's size).
    expect(drawn.rows).toBeGreaterThanOrEqual(10)
    expect(drawn.text).toContain('red green blue bold yellow')
    expect(drawn.text).toContain('你好，世界')
    // Colours are styles the terminal writes in place: under a policy that refused them every cell is one colour.
    expect(drawn.colours.length, drawn.colours.join(' | ')).toBeGreaterThanOrEqual(6)
    expect(drawn.colours.some((colour) => !colour.endsWith('rgba(0, 0, 0, 0)')), 'a cell with a background of its own').toBe(true)
    expect(drawn.cursors.length).toBe(1)
    expect(drawn.cursors[0]).toContain('xterm-cursor-block')
    await fits(tab, 'the full view', [])
    await shot(tab, '3d-terminal')

    const before = stage.studio.typed.length
    await tab.click('input[aria-label="Prompt Ada"]')
    await tab.type(`echo ${name}`)
    await tab.click('form:has(input[aria-label="Prompt Ada"]) button[type=submit]', 'Send')
    await tab.until(`/echo ${name}/.test(document.querySelector('.xterm-rows').innerText)`, 'the terminal to show what was sent')
    const sent = Date.now()
    while (!stage.studio.typed.slice(before).map((one) => one.data).join('').endsWith('\r')) {
      if (Date.now() - sent > 15_000) break
      await sleep(100)
    }
    // And nothing more after it.
    await sleep(2000)
    const arrived = stage.studio.typed.slice(before)
    // The words and the key that sends them, once: in one batch or two (keys typed close together ride one request), never twice.
    expect(arrived.every((one) => one.terminalId === ADA), JSON.stringify(arrived)).toBe(true)
    expect(arrived.map((one) => one.data).join(''), JSON.stringify(arrived)).toBe(`echo ${name}\r`)
    expect(new Set(arrived.map((one) => one.id)).size).toBe(arrived.length)
    await shot(tab, '3e-prompt-sent')
    settle('step 3', tab)
    passed.add(3)
  }, 3 * MINUTE)

  it('4. a link straight into an agent lands there cold; Back walks up the levels to Devices and no further; a reload stays where it was', async () => {
    needs(3)
    const id = stage.studio.deviceId
    const deep = `/d/${id}/w/${KITCHEN}/a/${ADA}`
    other = await browser.open(viewport, stage.clock.offset())
    await other.goto(`${origin()}${deep}`)
    await other.until(`/Plate the invented special/.test(document.body.innerText) && document.querySelector('input[aria-label="Prompt Ada"]')`, 'the agent’s card, from a cold link', 40_000)
    expect(await other.url()).toBe(`${origin()}${deep}`)
    await shot(other, '4a-deep-link')

    // A reload inside a machine stays there.
    await other.reload()
    await other.until(`/Plate the invented special/.test(document.body.innerText) && document.querySelector('input[aria-label="Prompt Ada"]')`, 'the agent’s card again after a reload', 40_000)
    expect(await other.url()).toBe(`${origin()}${deep}`)

    // Back, from the terminal in the first tab: one level out each time, never off the console.
    const walked: string[] = [new URL(await tab.url()).pathname]
    for (let press = 0; press < 8; press += 1) {
      if (await tab.evaluate<boolean>(`!!document.querySelector('.cd-grid') && location.pathname === '/'`)) break
      const went = await tab.back()
      expect(went, 'there is a level to go back to').toBe(true)
      await sleep(1200)
      const at = new URL(await tab.url())
      expect(at.origin, `Back left the console after ${walked.join(' → ')}`).toBe(origin())
      walked.push(at.pathname)
    }
    expect(walked.at(-1), walked.join(' → ')).toBe('/')
    await tab.until(`document.querySelector('.cd-grid .cd-tile')`, 'the Devices level')
    // Up the levels in order: never deeper than the step before, and every level of the way seen.
    const depth = (pathname: string): number => pathname.split('/').filter(Boolean).length
    for (let at = 1; at < walked.length; at += 1) expect(depth(walked[at]), walked.join(' → ')).toBeLessThanOrEqual(depth(walked[at - 1]))
    expect([...new Set(walked)]).toEqual([deep, `/d/${id}/w/${KITCHEN}`, `/d/${id}`, '/'])
    await shot(tab, '4b-back-at-devices')
    settle('step 4', tab, other)
    passed.add(4)
  }, 3 * MINUTE)

  it('5. inside a machine the page looks for a nearer way, finds none, stays on the relay and says so; nothing is asked in a loop', async () => {
    needs(4)
    // The other tab has been inside the machine since step 4.
    const asked = (what: RegExp): number => stage.studio.requests.filter((request) => what.test(`${request.method} ${request.path}`)).length
    await other.until(`document.querySelector('.cr-route-path')`, 'the path badge')
    const deadline = Date.now() + 20_000
    while (asked(/^POST \/api\/rtc\/offer/) === 0 || asked(/^GET \/api\/reach/) === 0) {
      if (Date.now() > deadline) throw new Error(`the machine never saw the search for a nearer way: ${stage.studio.requests.slice(-12).map((request) => `${request.method} ${request.path}`).join(', ')}`)
      await sleep(200)
    }
    const from = { at: Date.now(), total: stage.studio.requests.length, reach: asked(/^GET \/api\/reach/), offer: asked(/^POST \/api\/rtc\/offer/), fleet: asked(/^GET \/api\/fleet(\?|$)/) }
    await sleep(20_000)
    const window = stage.studio.requests.slice(from.total)
    const badge = await other.evaluate<{ label: string; title: string; relay: boolean }>(`(() => { const badge = document.querySelector('.cr-route-path'); return { label: badge.getAttribute('aria-label'), title: badge.getAttribute('title'), relay: badge.classList.contains('cr-path-relay') } })()`)
    expect(badge.relay).toBe(true)
    expect(badge.label).toBe('Connection: RELAY')
    expect(badge.title).toMatch(/relay/i)
    expect(badge.title).toMatch(/direct by itself/)
    // Twenty seconds on the relay with nowhere nearer to go: the search waits its turn, and nothing spins.
    expect(asked(/^POST \/api\/rtc\/offer/) - from.offer, 'WebRTC knocks in twenty seconds').toBeLessThanOrEqual(1)
    expect(asked(/^GET \/api\/reach/) - from.reach, 'reach cards read in twenty seconds').toBeLessThanOrEqual(2)
    expect(window.length, `requests in twenty seconds: ${window.map((request) => `${request.method} ${request.path.split('?')[0]}`).join(', ')}`).toBeLessThanOrEqual(40)
    await shot(other, '5-on-the-relay')
    // And on the Devices level the tile of the machine it reaches says how.
    const word = await tab.evaluate<{ word: string; says: string } | null>(`(() => { const path = document.querySelector('.cd-tile[data-standing=live] .cd-path'); return path ? { word: path.innerText, says: path.getAttribute('title') } : null })()`)
    expect(word).toEqual({ word: 'RELAY', says: 'Reached through the Cookrew relay' })
    settle('step 5', tab, other)
    passed.add(5)
  }, 3 * MINUTE)

  it('6. a second visit paints with the static host gone; a newer build is said, loads only when pressed, and leaves the other tab its files', async () => {
    needs(5)
    const build = (from: Tab): Promise<string> => from.evaluate<string>(`document.querySelector('meta[name="cookrew-build"]').content`)
    expect(await build(tab)).toBe(stage.first.id)
    // The worker holds the page and every file of its build.
    await tab.until(`navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === 'activated'`, 'the worker to hold the page', 30_000)
    expect((await storage(tab)).caches).toEqual([`cookrew-console-0.6.0-${stage.first.id}`])

    await stage.host.stop()
    const served = stage.host.requests.length
    await tab.reload()
    await tab.until(`document.querySelectorAll('.cd-tile[data-standing=live]').length >= 1`, 'the Devices level, painted from the worker’s cache', 40_000)
    expect(stage.host.requests.length).toBe(served)
    await shot(tab, '6a-host-stopped')
    await stage.host.start()

    // A newer build goes out. The page learns of it when it comes back to the front, and says so.
    stage.host.deploy(stage.next.dir)
    const loadsBefore = tab.loads()
    await awayAndBack(tab, other)
    await tab.until(`document.querySelector('.cd-newer') && /A newer console is ready\\./.test(document.querySelector('.cd-newer').innerText)`, 'the line that says a newer console is out', 30_000)
    await sleep(3000)
    // Nothing reloads by itself.
    expect(tab.loads()).toBe(loadsBefore)
    expect(await build(tab)).toBe(stage.first.id)
    await fits(tab, 'Devices, with a newer build out', ['.cd-newer-go'])
    await shot(tab, '6b-newer-console')

    // The other tab is still on the first build, with its terminal's chunk not loaded yet.
    const terminalChunks = (from: Tab): Promise<string[]> => from.evaluate<string[]>(`performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname).filter((name) => /^\\/assets\\/TerminalOverlay-.*\\.js$/.test(name))`)
    expect(await build(other)).toBe(stage.first.id)
    expect(await terminalChunks(other)).toEqual([])

    const hostBefore = stage.host.requests.length
    await tab.click('.cd-newer-go', 'Update')
    await tab.until(`document.querySelector('meta[name="cookrew-build"]') && document.querySelector('meta[name="cookrew-build"]').content === ${JSON.stringify(stage.next.id)} && document.querySelector('.cd-grid .cd-tile')`, 'the page to load again on the new build', 60_000)
    expect(await tab.evaluate<boolean>(`!document.querySelector('.cd-newer')`)).toBe(true)
    await shot(tab, '6c-updated')

    // The tab that did not press keeps running the build it has, and can still load what it had not loaded.
    await other.front()
    expect(await build(other)).toBe(stage.first.id)
    await openTerminal(other)
    const drawn = await terminal(other)
    expect(drawn.rows).toBeGreaterThanOrEqual(10)
    expect(drawn.colours.length).toBeGreaterThanOrEqual(6)
    expect(await build(other)).toBe(stage.first.id)
    // What it loaded just now is a file of the FIRST build, which the host no longer has: the
    // worker that took over answered it from the cache it kept, and the host was never asked.
    const loaded = await terminalChunks(other)
    expect(loaded.length).toBe(1)
    expect(existsSync(path.join(stage.first.dir, loaded[0]))).toBe(true)
    expect(existsSync(path.join(stage.next.dir, loaded[0])), 'the two builds name this chunk differently').toBe(false)
    expect(stage.host.requests.slice(hostBefore).map((request) => request.path)).not.toContain(loaded[0])
    expect((await storage(other)).caches.sort()).toEqual([`cookrew-console-0.6.0-${stage.first.id}`, `cookrew-console-0.6.0-${stage.next.id}`].sort())
    await shot(other, '6d-other-tab-terminal')
    settle('step 6', tab, other)
    passed.add(6)
  }, 4 * MINUTE)

  it('7. a session that ran out is renewed without a word; signing out ends it at the registry and leaves no token, pass or code behind', async () => {
    needs(6)
    await other.close()
    await tab.front()
    const held = (): Promise<{ token: string; exp: number }> => tab.evaluate(`JSON.parse(localStorage.getItem('cr_console_session'))`)
    const first = await held()
    const renewals = (): number => tab.requests.filter((request) => request.method === 'POST' && request.url.endsWith('/v2/sessions/renew') && request.status === 201).length
    const renewedBefore = renewals()

    // Sixteen minutes pass, for the registry and for the page, while the page is out of sight.
    const away = await browser.open(viewport, stage.clock.offset())
    await awayAndBack(tab, away, async () => {
      stage.clock.advance(16 * MINUTE)
      await tab.skew(16 * MINUTE)
    })
    await away.close()
    await tab.until(`JSON.parse(localStorage.getItem('cr_console_session') || '{}').token !== ${JSON.stringify(first.token)}`, 'the session to be renewed with the device key', 30_000)
    expect(renewals()).toBe(renewedBefore + 1)
    const second = await held()
    expect(second.exp).toBeGreaterThan(first.exp)
    // Nobody was asked anything: the same level, and the machines still answer.
    expect(await tab.evaluate<boolean>(`!document.querySelector('.cd-signin') && !document.querySelector('.cd-gate')`)).toBe(true)
    await tab.until(`document.querySelectorAll('.cd-tile[data-standing=live]').length >= 1`, 'the machines to answer on the renewed session', 30_000)
    const api = new Client(stage.site, 'after')
    expect((await api.console('GET', '/v2/me/desktops', undefined, bearer(first.token))).status).toBe(401)
    expect((await api.console('GET', '/v2/me/desktops', undefined, bearer(second.token))).status).toBe(200)
    await shot(tab, '7a-renewed')

    const before = await storage(tab)
    expect(before.local).toContain('cr_console_session')
    expect(before.local).toContain('cr_grant')
    expect(before.local.some((key) => key.startsWith('cr_token:'))).toBe(true)

    await tab.click('.cd-who button.cd-quiet', 'Sign out')
    await tab.until(`document.querySelector('.cd-signin .cd-primary')`, 'the signed-out view', 30_000)
    await sleep(1500)
    expect((await api.console('GET', '/v2/me/desktops', undefined, bearer(second.token))).status).toBe(401)
    const after = await storage(tab)
    const secret = (key: string): boolean => /session|grant|token|code|auth|pass/i.test(key)
    expect(after.local.filter(secret), `localStorage after signing out: ${after.local.join(', ')}`).toEqual([])
    expect(after.session.filter(secret), `sessionStorage after signing out: ${after.session.join(', ')}`).toEqual([])
    if (keptShots !== undefined) writeFileSync(path.join(shots, `${name}-storage.json`), JSON.stringify({ before, after }, null, 1))
    await shot(tab, '7b-signed-out')
    settle('step 7', tab)
    passed.add(7)
  }, 4 * MINUTE)

  it('and through all of it the machines were asked nothing they had no answer for', () => {
    needs(3)
    expect(stage.studio.unanswered).toEqual([])
    expect(stage.laptop.unanswered).toEqual([])
    expect(stage.old.unanswered).toEqual([])
  })

  it('and the machine too old for the console was asked nothing at all, from Devices or from inside another machine', () => {
    needs(3)
    expect(stage.old.requests.map((request) => `${request.method} ${request.path.split('?')[0]}`)).toEqual([])
  })
})
