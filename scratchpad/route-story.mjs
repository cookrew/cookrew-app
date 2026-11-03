// THE ROUTE STORYBOARD, ON THE PRODUCT SURFACE (route program, lane e2e, step 3).
//
// Six beats of the brief, driven through the real app over CDP — real clicks, real keys, real
// Sous, real gateway — with a reading taken off the product's own DOM at every stop:
//
//   1 r1-online     the header's Routing chip opens R1 and the status line is green
//   2 default-pick   one chip in the DEFAULT row, and routeState() agrees
//   3 cmdk           ⌘K · a RESERVED sentence · Sous echoes a RECRUIT decision · committed
//   4 recruited      the new card's RTE reads the default, and its first turn names the model
//   5 rte-pick        RTE → the group · the card respawns · the next turn is DECIDED by the group
//   6 offline         magpie stopped → the dial says "direct" and wears the offline flag
//
// Beat 5 learned something on its first real run: `group/smart` sent the turn to
// `ollama/qwen2.5:1.5b`, the member the card was already on, so the turn line was identical and
// the naive "wait for a different line" assertion reported a failure that had not happened. A
// router may legitimately pick the same model; what changed is who chose it. The assertion is
// the live RouteDecision now — a new `seq`, `asked` = the group, `group` = its name.
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
//   node scratchpad/route-story.mjs --go --from=5 --card=<terminalId>   # rerun 5–6 on that card
//
// `--from=N` starts at beat N and skips what is before it. Beats 5–6 act on one card, so from 5
// onwards `--card=<terminalId>` is required — the id beat 4 prints — and the card is found,
// zoomed and confirmed again rather than assumed to be on screen. That is what makes a failed
// beat 5 cheap to retry: no second recruit, no second haiku.
//
// Beat 6 stops the gateway on purpose and starts it again afterwards (the owner's cards are
// unaffected: a running card keeps whatever env it was spawned with).
//
// TWO THINGS THE FIRST LIVE RUN COST, both fixed here (lane e2e2, item 1):
//   · it exited with the card's xterm focused, and from then on every `cookrew ask` to that card
//     read "owner is composing" and dropped the brief. leaveClean() now runs on success, on
//     failure and on ^C, and records what it had to close.
//   · its sentence ("write a haiku about cables") shared a word with cards on the board, so Sous
//     ASKED one of them instead of recruiting. The sentence is drawn from RESERVED now, checked
//     against this board's own words, and beat 3 fails loudly if the decision is not `recruit`.
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
/**
 * THE RECRUIT SENTENCE IS RESERVED, NOT CHOSEN FOR FLAVOUR.
 *
 * `decide()` (shared/sous-decide.ts) ASKS an existing card whenever a same-repo idle card's role
 * or last task shares a content word with the sentence, and only RECRUITS when nothing fits. The
 * first live run said "write a haiku about cables" on a board with cable-harness and cable-signal
 * cards on it — "cables" overlapped, Sous asked one of them, and beat 4 waited for a card that was
 * never going to be made.
 *
 * So every sentence here is from a domain no card in this repo can be working in, and each one
 * also carries a LONG_RE word (tests · implement · pipeline) so `pickHarness` answers Claude Code
 * — never Pi, which is `routable: false` this round and would route nothing. `--say=…` overrides,
 * and then the overlap check still runs and says what it found.
 */
const RESERVED = [
  'implement a pangolin burrow census and write tests for the counter',
  'implement an ocarina fingering chart and test every pentatonic run',
  'build a marzipan lattice scaler pipeline with tests for each step',
  'implement a xylophone mallet tuner and write tests for the octaves'
]
const SAID = value('say', null)
const SHOT_DIR = value('shots', '/tmp')
const WORKSPACE = value('workspace', null)
/** Start at beat N (1-based). Beats 5–6 need `--card=<terminalId>` — the one beat 4 recruited. */
const FROM = Math.max(1, Number(value('from', 1)))
const CARD = value('card', null)
/** The group's own name, for the decision read-back: `group/smart` → `smart`. */
const SECOND_GROUP = SECOND.startsWith('group/') ? SECOND.slice('group/'.length) : null

/** Velvet's section-9 budget (report-panel.md), the numbers this run is counted against. */
const BUDGET = [
  { path: 'Open R1', clicks: 1, note: 'the header chip — not in the section 9 table, counted here because it is the way in' },
  { path: 'Set the fleet default', clicks: 1, note: 'a chip in the DEFAULT row' },
  { path: 'Command the crew (⌘K)', clicks: 0, note: 'keys only: ⌘K, the sentence, ↵, ↵' },
  { path: 'Change one card’s model', clicks: 2, note: 'RTE → pick' }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

/** The same stop list and tokens `decide()` matches on, enough of it to predict an overlap. */
const STOP = new Set(
  'the a an and or of to in on for with into from by at as is are be this that it its my our your please make add fix do all every keep then also just'.split(' ')
)
const words = (text) =>
  new Set(
    (String(text ?? '').toLowerCase().match(/[a-z0-9][a-z0-9_./-]*/g) ?? [])
      .filter((w) => w.length >= 2 && !STOP.has(w))
      .map((w) => w.replace(/^[./-]+|[./-]+$/g, ''))
  )

/**
 * The first reserved sentence that shares no content word with anything on the board — which is
 * what makes Sous recruit instead of ask. The card faces carry their last task as text, so this
 * reads the same words `decide()` would.
 */
function reservedSentence(cards) {
  const board = words(cards.map((c) => `${c.name} ${c.text ?? ''}`).join(' '))
  const list = SAID ? [SAID, ...RESERVED] : RESERVED
  const tried = []
  for (const sentence of list) {
    const clash = [...words(sentence)].filter((w) => board.has(w))
    tried.push({ sentence, clash })
    if (clash.length === 0) return { sentence, tried, boardWords: board.size }
  }
  throw new Error(`every reserved sentence overlaps a card on this board: ${JSON.stringify(tried)}`)
}

const story = { startedAt: new Date().toISOString(), gateway: GATEWAY, first: FIRST, second: SECOND, beats: [], budget: BUDGET }

/** The live driver, so ^C can tidy the app before the process goes. */
let driver = null
let leaving = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (leaving) process.exit(130)
    leaving = true
    process.stdout.write(`\n${signal} — leaving the app tidy before exit\n`)
    const done = () => {
      try {
        writeFileSync('/tmp/route-story.json', `${JSON.stringify({ ...story, interruptedBy: signal }, null, 2)}\n`)
      } catch {
        // the record is a courtesy; the tidy-up is the point
      }
      process.exit(130)
    }
    if (driver === null) done()
    else leaveClean(driver).then(done, done)
  })
}

function plan() {
  process.stdout.write(`\nTHE ROUTE STORYBOARD — ${BEATS.length} beats, ${BEATS.reduce((n, b) => n + b.budget, 0)} clicks budgeted\n`)
  for (const [i, beat] of BEATS.entries()) {
    process.stdout.write(
      `\n  ${i + 1}. ${beat.name}  (${beat.budget} click${beat.budget === 1 ? '' : 's'})\n     ${beat.what}\n     reads: ${beat.reads}\n     Sous path: ${beat.expects}\n`
    )
  }
  process.stdout.write('\n  Click budget to compare with (report-panel.md section 9):\n')
  for (const row of BUDGET) process.stdout.write(`    ${String(row.clicks)}  ${row.path} — ${row.note}\n`)
  process.stdout.write(`\n  Shots: ${SHOT_DIR}/route-story-<n>-<beat>.png · record: /tmp/route-story.json\n`)
  process.stdout.write(`  Rerun a late beat on the same card: --go --from=5 --card=<terminalId>${FROM > 1 ? ` (set: --from=${FROM}, card ${CARD ?? 'MISSING'})` : ''}\n`)
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
                   // The card face carries its last task; the reserved-sentence check reads it.
                   text: ((n.textContent || '').replace(/\\s+/g, ' ')).trim().slice(0, 400),
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

/**
 * The card beats 5–6 work on, zoomed and PROVED — whether beat 4 left it open or this is a
 * `--from=5 --card=<id>` rerun that has to find it again. Looking is not doing, so the taps it
 * costs are taken back off the count.
 */
async function ensureOpen(d, memo) {
  if (memo.card && (await d.openName()) === memo.card.name) return memo.card
  const id = memo.card?.id ?? CARD
  memo.rerun = memo.card === undefined
  if (!id) throw new Error('no card to work on — pass --card=<terminalId> when starting at beat 4 or later')
  await toBoard(d)
  const here = (await d.cards()).find((c) => c.id === id)
  if (!here) throw new Error(`no card ${id} on this canvas — is the app in the right workspace?`)
  await d.tap(here.x, here.y + Math.min(26, here.h / 6))
  d.clicks -= 1
  const name = await until('the overlay agrees which card it is', () => d.openName(), (n) => n === here.name, 20_000, 500)
  memo.card = { ...here, name }
  return memo.card
}

/**
 * LEAVE NOTHING FOCUSED, LEAVE NOTHING OPEN — on every exit path.
 *
 * The first live run ended with the card's xterm still holding the keyboard focus, and from then
 * on every `cookrew ask` to that card answered "owner is composing" and dropped the brief: a
 * focused composer is how the app knows a person is typing, and this script is not a person. So
 * success, failure and ^C all come through here: close the Routing panel, leave the overlay, blur
 * whatever has the focus, and WRITE DOWN what was left behind so a dirty exit is visible.
 */
async function leaveClean(d) {
  const exit = { panelWasOpen: false, overlayWasOpen: false, blurred: null, activeElement: null }
  try {
    exit.panelWasOpen = (await d.at('.cr-routing-panel')) !== null
    if (exit.panelWasOpen) {
      await d.escape()
      await sleep(400)
    }
    exit.overlayWasOpen = (await d.openName()) !== null
    await toBoard(d)
    exit.blurred = await d.ev(`(() => {
      const el = document.activeElement
      const was = el ? (el.className || el.tagName || '').toString().slice(0, 80) : null
      if (el && typeof el.blur === 'function') el.blur()
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
      return was
    })()`)
    exit.activeElement = await d.ev(
      `(() => { const el = document.activeElement; return el === null || el === document.body ? 'body' : (el.className || el.tagName || '').toString().slice(0, 80) })()`
    )
    exit.panelOpenAfter = (await d.at('.cr-routing-panel')) !== null
    exit.overlayOpenAfter = (await d.openName()) !== null
    exit.clean = exit.activeElement === 'body' && !exit.panelOpenAfter && !exit.overlayOpenAfter
  } catch (e) {
    exit.error = String(e?.message ?? e)
  }
  story.exit = exit
  return exit
}

const BEATS = [
  {
    name: 'r1-online',
    budget: 1,
    expects: 'no Sous',
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
    expects: 'no Sous',
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
    expects: 'recruit',
    what: '⌘K, a RESERVED sentence Sous cannot match to a card, ↵ for the decision, ↵ to commit it',
    reads: '.cmd-field input focus · .cmd-echo[data-decision] — which must read `recruit`',
    run: async (d, memo) => {
      // Picked here, against this board, not baked in: see reservedSentence().
      const chosen = reservedSentence(await d.cards())
      memo.sentence = chosen.sentence
      await d.commandK()
      await until('the ⌘K box opens', () => d.at('.cmd-field input'), (p) => p !== null, 8_000, 250)
      const focused = await d.ev(`document.activeElement === document.querySelector('.cmd-field input')`)
      await d.type(chosen.sentence)
      await d.enter()
      const echo = await until('Sous answers', () => d.text('.cmd-echo'), (t) => typeof t === 'string' && t.length > 0, 60_000)
      const kind = await d.ev(`(() => { const e = document.querySelector('.cmd-echo[data-decision]'); return e ? e.getAttribute('data-decision') : null })()`)
      // A sentence that was supposed to recruit and got an ask means the reserved list has aged
      // into this board's vocabulary — say so here, where it is cheap, not in beat 4's timeout.
      if (kind !== null && kind !== 'recruit') {
        throw new Error(`Sous answered "${kind}", not recruit, for a reserved sentence — ${JSON.stringify(chosen)}`)
      }
      // The card roll is taken HERE, one moment before the commit: a card another agent made
      // while beats 1–2 ran would otherwise be mistaken for the one Sous is about to recruit.
      memo.cardIds = (await d.cards()).map((c) => c.id)
      // A held decision commits on the second ↵; a plain answer has nothing to commit.
      if (kind !== null) await d.enter()
      await sleep(1200)
      return { focused, echo, decision: kind, sentence: chosen.sentence, clashesTried: chosen.tried.length - 1, boardWords: chosen.boardWords, cardsBefore: memo.cardIds.length }
    }
  },
  {
    name: 'recruited',
    budget: 0,
    expects: 'recruit — a NEW card; an ask would leave this beat waiting for a card nobody makes',
    what: 'the new card appears, its RTE reads the default, and its first turn names the model',
    reads: '.popout-name · [data-knob="route"] .cr-tune-v · .cr-tune-turn · terminalRoute(id)',
    run: async (d, memo) => {
      await d.escape()
      await sleep(400)
      // A rerun (`--from=4 --card=<id>`) re-reads the card that was already recruited; a full run
      // waits for the one Sous is about to make.
      if (!memo.card && CARD === null) {
        const before = new Set(memo.cardIds ?? [])
        const fresh = await until(
          'Sous recruits a card',
          async () => (await d.cards()).filter((c) => !before.has(c.id)),
          (list) => list.length > 0,
          120_000,
          1_500
        )
        memo.card = fresh[0]
      }
      // ensureOpen re-reads the coordinates AFTER leaving the overlay: the board may have panned,
      // and a tap at a stale point either misses or opens the neighbour.
      const { id: cardId, name } = await ensureOpen(d, memo)
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
      const state = await d.cardRoute(cardId)
      // Printed so a rerun has the one argument it needs: --from=5 --card=<id>.
      return { card: { id: cardId, name }, dial, turn, route: state?.route ?? null, effective: state?.effective ?? null, appliesOn: state?.appliesOn ?? null }
    }
  },
  {
    name: 'rte-pick',
    budget: 2,
    expects: 'no Sous — the sentence goes into the card’s own composer, not the box',
    what: `RTE → ${SECOND}; the card respawns with exact context and the next turn goes through it`,
    reads: 'route takes the pick · effective + appliesOn after the respawn · the live decision’s seq/asked/group',
    run: async (d, memo) => {
      const card = await ensureOpen(d, memo)
      /**
       * A RERUN STARTS FROM THE FIRST MODEL, OR IT PROVES NOTHING. After a run that reached beat
       * 5 the card is already on `--second`, and clicking the dial to the value it already holds
       * is not a change: the respawn never comes and the beat "fails" for the second time running.
       * So a rerun sets the card back to `--first` THROUGH THE API — the same PUT the dial makes —
       * and waits for `effective` before touching the chip.
       */
      const start = await d.cardRoute(card.id)
      if (start?.route !== FIRST) {
        await d.ev(`window.cookrew.terminalRouteSet(${JSON.stringify(card.id)}, ${JSON.stringify(FIRST)})`)
        memo.reset = await until(
          `the card goes back to ${FIRST} before the pick`,
          async () => {
            const s = await d.cardRoute(card.id)
            return { route: s?.route ?? null, effective: s?.effective ?? null, appliesOn: s?.appliesOn ?? null }
          },
          (s) => s.route === FIRST && s.effective === FIRST,
          180_000,
          2_000
        )
      }
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

      /**
       * THE NEXT TURN IS PROVED BY THE DECISION, NOT BY A DIFFERENT MODEL NAME.
       *
       * The first run of this read it the naive way — wait for a `.cr-tune-turn` line unlike the
       * previous one — and reported a failure that was not one: `group/smart` routed the turn to
       * `ollama/qwen2.5:1.5b`, which is the member the card was already on, so the turn line was
       * word-for-word identical. A router is allowed to pick the same model; what changed is WHO
       * chose it. So the proof is the live RouteDecision: a NEW `seq` on this card's session,
       * `asked` = the group that was picked, and `group` = its name. The turn line is kept as
       * evidence, never as the assertion.
       *
       * `seq` is monotonic per session and the session is `cookrew:<cardId>`, which the respawn
       * does not change — so it survives exactly the event this beat is about. The decision that
       * satisfies this may be the respawned harness's own first request rather than the sentence
       * typed below; either one is a request the group decided, which is the claim.
       */
      const before = (await d.cardRoute(card.id))?.live?.seq ?? 0
      const term = await d.at('.xterm-screen')
      if (term) {
        await d.tap(term.x, term.y)
        d.clicks -= 1 // focusing a pane to talk is not a route click
        await d.type('Say the word READY and nothing else.')
        await d.enter()
      }
      const live = await until(
        `the next turn is routed through ${SECOND}`,
        async () => {
          const l = (await d.cardRoute(card.id))?.live ?? null
          return l === null ? null : { seq: l.seq, asked: l.asked, group: l.group, model: l.model, status: l.status, done: l.done }
        },
        (l) => l !== null && l.seq > before && l.asked === SECOND && (SECOND_GROUP === null || l.group === SECOND_GROUP),
        180_000,
        2_000
      )
      const turn = await d.text('[data-knob="route"] .cr-tune-turn')
      // Said plainly, because it is the thing that fooled the first run: the member may be the
      // same model the card was on before, and that is a pass.
      const sameMember = typeof turn === 'string' && typeof memo.lastTurn === 'string' && turn === memo.lastTurn
      return { asked, ...settled, dial, seqBefore: before, live, turn, turnLineUnchanged: sameMember }
    }
  },
  {
    name: 'offline',
    budget: 0,
    expects: 'no Sous',
    what: 'stop magpie; the dial says direct and wears the offline flag',
    reads: '.cr-tune-chip.refused · .cr-tune-v · routeState().status',
    run: async (d, memo) => {
      // The dial is only on a zoomed card, so a `--from=6` rerun has to open one first.
      await ensureOpen(d, memo)
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
  if (FROM >= 5 && CARD === null) {
    throw new Error(`--from=${FROM} works on the card beat 4 recruited: pass --card=<terminalId> (beat 4 prints it)`)
  }
  const d = await attach()
  driver = d
  const memo = {}
  try {
    if (WORKSPACE) {
      const where = await d.text('.cr-ws-current')
      if (where && !new RegExp(WORKSPACE, 'i').test(where)) {
        throw new Error(`the app is in ${where}, not ${WORKSPACE} — switch it by hand; this script does not move the owner between workspaces`)
      }
    }
    memo.cardIds = (await d.cards()).map((c) => c.id)
    story.from = FROM
    story.card = CARD
    for (const [i, beat] of BEATS.entries()) {
      if (i + 1 < FROM) {
        process.stdout.write(`  · ${i + 1}/${BEATS.length} ${beat.name} — skipped (--from=${FROM})\n`)
        story.beats.push({ name: beat.name, skipped: true })
        continue
      }
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
    // Every exit path, including a ^C that lands mid-beat: nothing focused, nothing open.
    await leaveClean(d)
    if (!flag('leave-stopped') && !(await gatewayUp())) {
      await startGateway().catch(() => undefined)
      story.gatewayRestarted = await gatewayUp()
    }
    story.clicks = d.clicks
    story.finishedAt = new Date().toISOString()
    writeFileSync('/tmp/route-story.json', `${JSON.stringify(story, null, 2)}\n`)
    d.close()
  }
  const ran = story.beats.filter((b) => !b.skipped)
  const failed = ran.filter((b) => b.error)
  const tally = failed.length === 0 ? `${ran.length}/${ran.length} BEATS` : `${ran.length - failed.length}/${ran.length} BEATS · ${failed.map((b) => b.name).join(', ')} failed`
  process.stdout.write(`\n${tally} · ${story.clicks} clicks · /tmp/route-story.json\n\n`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
