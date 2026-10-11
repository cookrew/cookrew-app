// THE ROUTE STORYBOARD, ON THE PRODUCT SURFACE (route program, lane e2e, step 3).
//
// Six beats of the brief, driven through the real app over CDP — real clicks, real keys, real
// Sous, real gateway — with a reading taken off the product's own DOM at every stop:
//
//   1 r1-online     the header's Routing chip opens R1 and the status line is green
//   2 default-pick   one chip in the DEFAULT row, and routeState() agrees
//   3 cmdk           ⌘K · "write a haiku about cables" · Sous echoes a decision · committed
//   4 recruited      the new card's RTE reads the default, and its first turn names the model
//   5 rte-pick       RTE → the other model · the card respawns · the next turn names that one
//   6 offline        magpie stopped → the dial says "direct" and wears the offline flag
//
// Every selector below is taken from the MERGED renderer (branch route-merge), not from a mock:
//   .cr-routing-entry          Header.tsx → RoutingEntry
//   .cr-routing-panel          RoutingPanel.tsx (role=dialog, aria-modal)
//   .cr-routing-status.online  RoutingSections.tsx → StatusLine, class = statusLine().status
//   .cr-routing-default button.cr-routing-pick[role=radio]   the DEFAULT row, text = the id
//   .cmd-field input           CommandBox.tsx (aria-label "Tell the crew what to do")
//   .cmd-echo[data-decision]   Sous's held decision; a second ↵ commits it
//   [data-knob="route"]        TuneRail.tsx → RouteDial: .cr-tune-chip / .cr-tune-v /
//                              .cr-tune-turn / .cr-tune-list button.cr-tune-row
//   .popout-name               TerminalOverlay.tsx — the ZOOMED card's own identity, which is
//                              the only honest proof of which card a frame shows
//
// IT DOES NOTHING WITHOUT --go. Reading the plan is safe at any time:
//
//   node scratchpad/route-story.mjs --plan          # beats, selectors, click budget; no CDP
//   node scratchpad/route-story.mjs --go            # the storyboard, against the running app
//   node scratchpad/route-story.mjs --go --leave-stopped   # do not restart magpie at the end
//
// Beat 6 stops the gateway on purpose and starts it again afterwards (the owner's cards are
// unaffected: a running card keeps whatever env it was spawned with).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const PORT = Number(value('port', process.env.COOKREW_CDP_PORT ?? 9333))
const GATEWAY = value('gateway', 'http://127.0.0.1:3425')
/** The model the fleet default is set to in beat 2 — the one Ollama already holds, so beat 4's turn is fast. */
const FIRST = value('first', 'ollama/qwen2.5:1.5b')
/** The model beat 5 turns the dial to. A group is the honest second choice: it is what a card should ride. */
const SECOND = value('second', 'group/smart')
const SENTENCE = value('say', 'write a haiku about cables')
const SHOT_DIR = value('shots', '/tmp')
const WORKSPACE = value('workspace', null)

/** Velvet's section-9 budget (report-panel.md), the numbers this run is counted against. */
const BUDGET = [
  { path: 'Open R1', clicks: 1, note: 'the header chip — not in the section 9 table, counted here because it is the way in' },
  { path: 'Set the fleet default', clicks: 1, note: 'a chip in the DEFAULT row' },
  { path: 'Command the crew (⌘K)', clicks: 0, note: 'keys only: ⌘K, the sentence, ↵, ↵' },
  { path: 'Change one card’s model', clicks: 2, note: 'RTE → pick' }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

const story = { startedAt: new Date().toISOString(), gateway: GATEWAY, first: FIRST, second: SECOND, beats: [], budget: BUDGET }

function plan() {
  process.stdout.write(`\nTHE ROUTE STORYBOARD — ${BEATS.length} beats, ${BEATS.reduce((n, b) => n + b.budget, 0)} clicks budgeted\n`)
  for (const [i, beat] of BEATS.entries()) {
    process.stdout.write(`\n  ${i + 1}. ${beat.name}  (${beat.budget} click${beat.budget === 1 ? '' : 's'})\n     ${beat.what}\n     reads: ${beat.reads}\n`)
  }
  process.stdout.write('\n  Click budget to compare with (report-panel.md section 9):\n')
  for (const row of BUDGET) process.stdout.write(`    ${String(row.clicks)}  ${row.path} — ${row.note}\n`)
  process.stdout.write(`\n  Shots: ${SHOT_DIR}/route-story-<n>-<beat>.png · record: /tmp/route-story.json\n`)
  process.stdout.write('  Nothing was driven: pass --go to run it against the app.\n\n')
}

// ───────────────────────────────── the driver ─────────────────────────────────

/** One CDP attachment to the app's own renderer, with every click counted. */
async function attach() {
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  const page = targets.find((t) => t.type === 'page' && /localhost:5173|index\.html/.test(t.url)) ?? targets.find((t) => t.type === 'page')
  if (!page) throw new Error(`no renderer page on :${PORT} — is the app running with --remote-debugging-port=${PORT}?`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('the debugger refused the socket'))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data)
    if (m.id === undefined || !pending.has(m.id)) return
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(`${m.error.message} ${m.error.data ?? ''}`)) : resolve(m.result)
  }
  const send = (method, params = {}) => {
    const next = ++id
    ws.send(JSON.stringify({ id: next, method, params }))
    return new Promise((resolve, reject) => {
      pending.set(next, { resolve, reject })
      setTimeout(() => {
        if (pending.delete(next)) reject(new Error(`CDP timeout ${method}`))
      }, 60_000)
    })
  }
  await send('Page.enable')
  await send('Runtime.enable')

  const d = {
    clicks: 0,
    close: () => ws.close(),
    ev: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value,
    shot: async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png' })
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, Buffer.from(r.data, 'base64'))
      return file
    },
    /** A real click, counted — the count is the thing the section-9 budget is about. */
    tap: async (x, y) => {
      d.clicks += 1
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await sleep(70)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await sleep(40)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(260)
    },
    /** Characters, one at a time, as insertText — `char` events double-type into xterm. */
    type: async (text, every = 38) => {
      for (const ch of text) {
        await send('Input.insertText', { text: ch })
        await sleep(every)
      }
    },
    key: async (key, code = key, vk, modifiers = 0) => {
      const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
      if (key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', modifiers })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      await sleep(160)
    },
    enter: () => d.key('Enter', 'Enter', 13),
    escape: () => d.key('Escape', 'Escape', 27),
    /** ⌘K: modifiers 4 is Meta, which is what App.tsx's handler reads (metaKey || ctrlKey). */
    commandK: () => d.key('k', 'KeyK', 75, 4),
    /** Centre of the first match, or null. */
    at: async (selector, nth = 0) => {
      const v = await d.ev(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${nth}]
        if (!el) return null
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return null
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height })
      })()`)
      return v ? JSON.parse(v) : null
    },
    /** Centre of the first match whose text reads exactly `text`. */
    atText: async (selector, text) => {
      const v = await d.ev(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.textContent || '').trim() === ${JSON.stringify(text)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
      })()`)
      return v ? JSON.parse(v) : null
    },
    /** The trimmed text of the first match, or null. */
    text: (selector) =>
      d.ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? (e.textContent || '').trim() : null })()`),
    /** Every card on the canvas, by id and name. */
    cards: async () =>
      JSON.parse(
        await d.ev(`JSON.stringify([...document.querySelectorAll('.react-flow__node')].map((n) => {
          const t = n.querySelector('.vi-title,.node-title,.vi-mini-name')
          const r = n.getBoundingClientRect()
          return { id: n.getAttribute('data-id'), name: ((t ? t.textContent : '') || '').trim(),
                   x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), h: Math.round(r.height) }
        }))`)
      ),
    /** The card the zoomed overlay belongs to, by its own header. */
    openName: () => d.text('.popout-name'),
    /** The product's own answer, not the DOM's: window.cookrew is the contextBridge api. */
    routeState: () => d.ev('window.cookrew ? window.cookrew.routeState() : null'),
    cardRoute: (terminalId) => d.ev(`window.cookrew ? window.cookrew.terminalRoute(${JSON.stringify(terminalId)}) : null`)
  }
  return d
}

/** Poll a reading until it satisfies `ok`, or give up and say what it was. */
async function until(what, read, ok, timeoutMs = 60_000, everyMs = 700) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (ok(last)) return last
    await sleep(everyMs)
  }
  throw new Error(`${what}: never happened — last reading ${JSON.stringify(last)}`)
}

const sh = (bin, argv) =>
  new Promise((resolve) => {
    const child = spawn(bin, argv, { stdio: 'ignore', detached: bin !== 'pkill' })
    if (bin !== 'pkill') {
      child.unref()
      resolve(0)
      return
    }
    child.on('close', (code) => resolve(code))
  })

const gatewayUp = () => fetch(`${GATEWAY}/api/hello`).then((r) => r.ok).catch(() => false)

async function stopGateway() {
  await sh('pkill', ['-f', 'magpie serve'])
  await until('the gateway stops answering', gatewayUp, (up) => up === false, 20_000, 400)
}

async function startGateway() {
  await sh(path.join(process.env.HOME ?? '', '.local', 'bin', 'magpie'), ['serve'])
  await until('the gateway comes back', gatewayUp, (up) => up === true, 40_000, 500)
}

// ───────────────────────────────── the beats ─────────────────────────────────

/** Leave whatever is zoomed, so a beat always starts on the board. */
async function toBoard(d) {
  const back = await d.ev(`(() => { const e = [...document.querySelectorAll('button')].find((b) => /^Back to canvas/i.test(b.getAttribute('title') || '')); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }) })()`)
  if (back) {
    const p = JSON.parse(back)
    await d.tap(p.x, p.y)
    d.clicks -= 1 // housekeeping, not a step of the story
    await sleep(1200)
  }
}

const BEATS = [
  {
    name: 'r1-online',
    budget: 1,
    what: 'click the header’s Routing chip; R1 opens and its status line is green',
    reads: '.cr-routing-panel · .cr-routing-status.online text · routeState().status',
    run: async (d) => {
      await toBoard(d)
      const chip = await d.at('button.cr-routing-entry')
      if (!chip) throw new Error('no Routing chip in the header — is this build the merged one?')
      await d.tap(chip.x, chip.y)
      await until('R1 opens', () => d.at('.cr-routing-panel'), (p) => p !== null, 10_000, 300)
      const status = await until('the status line goes green', () => d.text('.cr-routing-status.online'), (t) => typeof t === 'string', 20_000)
      const state = await d.routeState()
      return { status, gatewayStatus: state?.status ?? null, defaultModel: state?.defaultModel ?? null, source: state?.gateway?.source ?? null }
    }
  },
  {
    name: 'default-pick',
    budget: 1,
    what: `click the ${FIRST} chip in the DEFAULT row`,
    reads: 'the chip’s aria-checked · routeState().defaultModel',
    run: async (d) => {
      const chip = await d.atText('.cr-routing-default button.cr-routing-pick', FIRST)
      if (!chip) throw new Error(`the DEFAULT row offers no ${FIRST} — check the catalogue`)
      await d.tap(chip.x, chip.y)
      const picked = await until(
        'the default is taken',
        async () => (await d.routeState())?.defaultModel ?? null,
        (m) => m === FIRST,
        15_000
      )
      const checked = await d.ev(`(() => { const e = [...document.querySelectorAll('.cr-routing-default button.cr-routing-pick')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(FIRST)}); return e ? e.getAttribute('aria-checked') : null })()`)
      await d.escape() // the panel closes on Escape; not a click
      await sleep(600)
      return { defaultModel: picked, ariaChecked: checked }
    }
  },
  {
    name: 'cmdk',
    budget: 0,
    what: `⌘K, type "${SENTENCE}", ↵ for Sous’s decision, ↵ to commit it`,
    reads: '.cmd-field input focus · .cmd-echo[data-decision] text',
    run: async (d, memo) => {
      await d.commandK()
      await until('the ⌘K box opens', () => d.at('.cmd-field input'), (p) => p !== null, 8_000, 250)
      const focused = await d.ev(`document.activeElement === document.querySelector('.cmd-field input')`)
      await d.type(SENTENCE)
      await d.enter()
      const echo = await until('Sous answers', () => d.text('.cmd-echo'), (t) => typeof t === 'string' && t.length > 0, 60_000)
      const kind = await d.ev(`(() => { const e = document.querySelector('.cmd-echo[data-decision]'); return e ? e.getAttribute('data-decision') : null })()`)
      // The card roll is taken HERE, one moment before the commit: a card another agent made
      // while beats 1–2 ran would otherwise be mistaken for the one Sous is about to recruit.
      memo.cardIds = (await d.cards()).map((c) => c.id)
      // A held decision commits on the second ↵; a plain answer has nothing to commit.
      if (kind !== null) await d.enter()
      await sleep(1200)
      return { focused, echo, decision: kind, cardsBefore: memo.cardIds.length }
    }
  },
  {
    name: 'recruited',
    budget: 0,
    what: 'the new card appears, its RTE reads the default, and its first turn names the model',
    reads: '.popout-name · [data-knob="route"] .cr-tune-v · .cr-tune-turn · terminalRoute(id)',
    run: async (d, memo) => {
      await d.escape()
      await sleep(400)
      const before = new Set(memo.cardIds ?? [])
      const fresh = await until(
        'Sous recruits a card',
        async () => (await d.cards()).filter((c) => !before.has(c.id)),
        (list) => list.length > 0,
        120_000,
        1_500
      )
      const card = fresh[0]
      await toBoard(d)
      // Coordinates are re-read AFTER leaving the overlay: the board may have panned, and a tap
      // at a stale point either misses or opens the neighbour.
      const here = (await d.cards()).find((c) => c.id === card.id)
      if (!here) throw new Error(`card ${card.id} left the canvas before it could be opened`)
      await d.tap(here.x, here.y + Math.min(26, here.h / 6))
      d.clicks -= 1 // zooming to look is not a step of the route path
      const name = await until('the overlay agrees which card it is', () => d.openName(), (n) => n === here.name, 20_000, 500)
      const dial = await until(
        'the RTE dial reads the default',
        () => d.text('[data-knob="route"] .cr-tune-v'),
        (t) => typeof t === 'string' && t !== '—',
        30_000
      )
      const turn = await until(
        'the first routed turn is counted',
        () => d.text('[data-knob="route"] .cr-tune-turn'),
        (t) => typeof t === 'string' && t.length > 0,
        180_000,
        2_000
      )
      const state = await d.cardRoute(card.id)
      memo.card = card
      return { card: { id: card.id, name }, dial, turn, route: state?.route ?? null, effective: state?.effective ?? null, appliesOn: state?.appliesOn ?? null }
    }
  },
  {
    name: 'rte-pick',
    budget: 2,
    what: `RTE → ${SECOND}; the card respawns with exact context and the next turn names it`,
    reads: 'the chip’s pending flag clearing · .cr-tune-v · a new .cr-tune-turn',
    run: async (d, memo) => {
      const card = memo.card
      if (!card) throw new Error('no card from the previous beat')
      const chip = await d.at('[data-knob="route"] button.cr-tune-chip')
      if (!chip) throw new Error('no RTE chip on this card — a served session has none by design')
      await d.tap(chip.x, chip.y)
      const row = await until('the route list opens', () => d.atText('[data-knob="route"] .cr-tune-list button.cr-tune-row', SECOND), (p) => p !== null, 8_000, 250)
      await d.tap(row.x, row.y)
      const asked = await until(
        'the card takes the new route',
        async () => (await d.cardRoute(card.id))?.route ?? null,
        (r) => r === SECOND,
        20_000
      )
      // The contract: a pick applies on the next restart, and the service respawns in place with
      // exact context — so the reading settles to the new value with no flag left on the chip.
      const settled = await until(
        'the respawn makes the pick effective',
        async () => {
          const s = await d.cardRoute(card.id)
          return { route: s?.route ?? null, effective: s?.effective ?? null, appliesOn: s?.appliesOn ?? null }
        },
        (s) => s.effective === SECOND && s.appliesOn === 'now',
        180_000,
        2_000
      )
      const dial = await d.text('[data-knob="route"] .cr-tune-v')
      // The next turn, said into the card's own composer the way a person would.
      const term = await d.at('.xterm-screen')
      if (term) {
        await d.tap(term.x, term.y)
        d.clicks -= 1 // focusing a pane to talk is not a route click
        await d.type('Say the word READY and nothing else.')
        await d.enter()
      }
      const turn = await until(
        'the next turn names the new model',
        () => d.text('[data-knob="route"] .cr-tune-turn'),
        (t) => typeof t === 'string' && t.length > 0 && t !== memo.lastTurn,
        180_000,
        2_000
      )
      return { asked, ...settled, dial, turn }
    }
  },
  {
    name: 'offline',
    budget: 0,
    what: 'stop magpie; the dial says direct and wears the offline flag',
    reads: '.cr-tune-chip.refused · .cr-tune-v · routeState().status',
    run: async (d) => {
      await stopGateway()
      // The monitor re-probes on its own 30 s clock while the window holds it, so this waits a
      // whole clock plus slack rather than poking anything.
      const status = await until('the app notices', async () => (await d.routeState())?.status ?? null, (s) => s === 'offline', 90_000, 2_000)
      const refused = await until(
        'the dial flags the gateway',
        () => d.ev(`(() => { const e = document.querySelector('[data-knob="route"] button.cr-tune-chip'); return e ? e.className : null })()`),
        (cls) => typeof cls === 'string' && /refused/.test(cls),
        60_000,
        1_500
      )
      const dial = await d.text('[data-knob="route"] .cr-tune-v')
      return { status, chipClass: refused, dial }
    }
  }
]

// ───────────────────────────────── the run ─────────────────────────────────

async function main() {
  if (!flag('go')) {
    plan()
    return
  }
  if (!(await gatewayUp())) throw new Error(`${GATEWAY} does not answer — beat 1 needs a live gateway`)
  const d = await attach()
  const memo = {}
  try {
    if (WORKSPACE) {
      const where = await d.text('.cr-ws-current')
      if (where && !new RegExp(WORKSPACE, 'i').test(where)) {
        throw new Error(`the app is in ${where}, not ${WORKSPACE} — switch it by hand; this script does not move the owner between workspaces`)
      }
    }
    memo.cardIds = (await d.cards()).map((c) => c.id)
    for (const [i, beat] of BEATS.entries()) {
      const at = d.clicks
      const startedAt = Date.now()
      process.stdout.write(`\n▶ ${i + 1}/${BEATS.length} ${beat.name} — ${beat.what}\n`)
      let reading = null
      let error = null
      try {
        reading = await beat.run(d, memo)
      } catch (e) {
        error = String(e?.message ?? e)
      }
      const shot = await d.shot(path.join(SHOT_DIR, `route-story-${i + 1}-${slug(beat.name)}.png`))
      const clicks = d.clicks - at
      story.beats.push({ name: beat.name, clicks, budget: beat.budget, seconds: Math.round((Date.now() - startedAt) / 1000), reading, error, shot })
      if (reading?.turn) memo.lastTurn = reading.turn
      process.stdout.write(`   ${error ? `✗ ${error}` : '✓'} · ${clicks} click${clicks === 1 ? '' : 's'} (budget ${beat.budget}) · ${shot}\n`)
      if (reading) process.stdout.write(`   ${JSON.stringify(reading)}\n`)
      if (error) break
    }
  } finally {
    if (!flag('leave-stopped') && !(await gatewayUp())) {
      await startGateway().catch(() => undefined)
      story.gatewayRestarted = await gatewayUp()
    }
    story.clicks = d.clicks
    story.finishedAt = new Date().toISOString()
    writeFileSync('/tmp/route-story.json', `${JSON.stringify(story, null, 2)}\n`)
    d.close()
  }
  const failed = story.beats.filter((b) => b.error)
  process.stdout.write(`\n${failed.length === 0 ? 'ALL SIX BEATS' : `${story.beats.length - failed.length}/${BEATS.length} BEATS`} · ${story.clicks} clicks · /tmp/route-story.json\n\n`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
