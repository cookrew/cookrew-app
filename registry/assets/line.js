/* cookrew.dev — THE LINE: a served team's own terminal, in the browser.
 *
 * This is resources/orch-line.mjs ported to the page: the same four routes
 * at the door (/api/call/assert, /line, /line/raw, /line/resize), the same
 * ladder (401 · 402 · 403 · 429 · 410), the same SSE PTY, the same rail from
 * /turns and /trace. What the card gets from the app's relay proxy this page
 * does itself: every exchange is sealed to the door's key (X25519 → HKDF →
 * AES-GCM, byte-for-byte src/shared/relay-seal.ts) and carried by
 * POST /v1/relay/call, so the relay moves bytes it cannot read.
 *
 * The line opens on a click, never on load.
 */
;(() => {
  'use strict'
  const root = document.getElementById('team')
  if (!root || !window.Terminal) return
  const $ = (id) => document.getElementById(id)
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const door = root.dataset.door
  const doorKey = root.dataset.sealKey
  const relayed = root.dataset.relayed === '1'
  const orch = root.dataset.orch || 'the door'
  const account = () => window.cookrewAccount
  const toast = (m, ms) => account()?.toast?.(m, ms)

  /* ── bytes ─────────────────────────────────────────────────────────────── */
  const b64u = (bytes) => {
    let s = ''
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  /* ── the seal lives in seal.js (CookrewSeal), tested against the Node one ── */
  const Seal = globalThis.CookrewSeal
  if (!Seal) return

  /* ── one exchange through the relay ────────────────────────────────────── */
  /** A buffered answer's ceiling — the same as the app's relay caller. */
  const MAX_HELD_CHARS = 8 * 1024 * 1024
  /** Reconnects back off from ~1 s to a minute and give up after this many in a row. */
  const RECONNECT_MAX_MS = 60_000
  const RECONNECT_LIMIT = 40
  const STRIPE_CHECKOUT = /^https:\/\/checkout\.stripe\.com\//
  let seq = 0
  const [handle, team] = door.replace(/^@/, '').split('/')
  const callPath = `/v1/relay/call/${encodeURIComponent(`@${handle}`)}/${encodeURIComponent(team)}`

  /**
   * POST the sealed op, read NDJSON frames back. `onChunk` receives decrypted
   * chunks as they arrive (the line); the promise resolves with the whole
   * answer for everything else.
   */
  async function exchange(method, path, headers, body, onHead, onChunk, signal) {
    const id = `w${++seq}`
    const seal = await Seal.seal(doorKey, door)
    const packed = await seal.pack(headers, body ?? '')
    const op = { id, method, path, headers: packed.headers }
    // A GET carries no body frame — the reference caller (relay-caller.ts)
    // sends one only for methods that have a body, and the relay forwards a
    // frame only when there are bytes.
    const bodiless = method === 'GET' || method === 'HEAD'
    const res = await fetch(callPath, {
      method: 'POST',
      headers: { 'x-relay-op': b64u(enc.encode(JSON.stringify(op))), 'content-type': 'application/octet-stream' },
      body: bodiless ? '' : packed.body,
      signal
    })
    if (res.status === 404) throw new LineError('not-serving', `${door} is not serving right now`)
    if (!res.ok) throw new LineError('relay', `the relay answered ${res.status}`)
    const reader = res.body.getReader()
    let buffer = ''
    let head = null
    let rx = null
    let n = 0
    let held = 0
    const chunks = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += dec.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        if (frame.id !== id) continue
        if (frame.t === 'head') {
          const e = frame.headers?.['x-seal-e']
          const h = frame.headers?.['x-seal-h']
          if (typeof e !== 'string' || typeof h !== 'string') throw new LineError('seal', 'the door answered without the seal')
          rx = await seal.finish(e)
          const opened = await rx.open(h, n++)
          if (opened === null) throw new LineError('seal', "the door's headers did not verify")
          head = { status: frame.status, headers: JSON.parse(opened) }
          onHead?.(head)
        } else if (frame.t === 'chunk' && rx) {
          const opened = await rx.open(frame.data, n++)
          if (opened === null) throw new LineError('seal', 'a relayed frame did not verify')
          if (onChunk) onChunk(opened)
          else {
            held += opened.length
            if (held > MAX_HELD_CHARS) throw new LineError('relay', 'the door answered with more than this page will hold')
            chunks.push(opened)
          }
        } else if (frame.t === 'end') {
          return { status: head?.status ?? 0, headers: head?.headers ?? {}, body: chunks.join('') }
        } else if (frame.t === 'abort') {
          throw new LineError(frame.reason === 'not-serving' ? 'not-serving' : 'relay', `the relay dropped the call: ${frame.reason}`)
        }
      }
    }
    return { status: head?.status ?? 0, headers: head?.headers ?? {}, body: chunks.join('') }
  }
  class LineError extends Error {
    constructor(kind, message) {
      super(message)
      this.kind = kind
    }
  }
  const jsonOf = (text) => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /* ── the terminal ──────────────────────────────────────────────────────── */
  const term = new window.Terminal({
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
    fontSize: 13,
    theme: { background: '#14110a', foreground: '#e9b949', cursor: '#ffd77a', selectionBackground: '#8a6d1c' },
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false
  })
  const fit = window.FitAddon ? new window.FitAddon.FitAddon() : null
  term.open($('term'))
  if (fit) term.loadAddon(fit)
  const dim = (text) => `\x1b[2m${text}\x1b[0m`
  const note = (text) => term.write(`\r\n${dim(text)}\r\n`)

  /* ── state ─────────────────────────────────────────────────────────────── */
  let doorToken = null
  let lineUp = false
  let everUp = false
  let closed = false
  let awaitingNewSession = false
  let startNewSession = false
  let payment = null
  let controller = null
  let turnsSeen = 0
  let pollTimer = null

  const setPhase = (phase, sentence) => {
    $('phase').textContent = phase
    if (sentence) $('state').textContent = sentence
  }
  const setOpened = (text) => ($('strip-opened').textContent = text)
  const gate = (title, text, actions) => {
    const g = $('gate')
    if (title === null) {
      g.hidden = true
      return
    }
    $('gate-h').textContent = title
    $('gate-p').textContent = text
    const row = $('gate-actions')
    row.replaceChildren(...actions)
    g.hidden = false
  }
  const button = (label, primary, onClick) => {
    const b = document.createElement('button')
    b.className = `btn${primary ? ' primary' : ''}`
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  /* ── sign-in at the door, with the registry's word ─────────────────────── */
  async function signIn() {
    const acct = account()
    if (!acct) throw new LineError('account', 'the account script did not load')
    const handleName = await acct.handle()
    if (!handleName) throw new LineError('account', 'sign in to cookrew.dev first')
    const registryToken = await acct.token('call', door)
    const JSON_HEADERS = { 'content-type': 'application/json' }
    let res = await exchange('POST', '/api/call/assert', JSON_HEADERS, JSON.stringify({ registryToken }))
    if (res.status === 401) {
      // A door whose app predates registry tokens still takes the ceremony
      // orch-line.mjs performs: sign its challenge with this account's own key.
      const key = await acct.doorKey()
      if (!key) throw new LineError('refused', "the door does not take cookrew.dev accounts yet — the owner's app needs updating")
      const face = jsonOf((await exchange('GET', '/crew', {}, '')).body)
      const serviceId = face?.serviceId
      if (typeof serviceId !== 'string' || !serviceId) throw new LineError('refused', 'this door did not say who it is')
      const challenge = jsonOf((await exchange('POST', '/api/call/challenge', JSON_HEADERS, '{}')).body)?.challenge
      if (typeof challenge !== 'string') throw new LineError('refused', 'no challenge — is the team still serving?')
      const signature = await key.sign(`cookrew-call/1\n${serviceId}\n${key.sub}\n${challenge}`)
      res = await exchange('POST', '/api/call/assert', JSON_HEADERS, JSON.stringify({ sub: key.sub, challenge, signature, jwk: key.jwk }))
    }
    if (res.status !== 200) throw new LineError('refused', `the door refused this account (${res.status}) — this name may belong to another key there`)
    const body = jsonOf(res.body)
    if (!body?.token) throw new LineError('refused', 'the door minted no token')
    doorToken = body.token
    return handleName
  }
  const auth = () => ({ authorization: `Bearer ${doorToken}`, ...(payment ? { 'x-payment': payment } : {}) })

  /* ── the line ──────────────────────────────────────────────────────────── */
  async function connectLine() {
    if (closed) return
    controller = new AbortController()
    let sse = ''
    let refusal = ''
    let status = 0
    setPhase('OPENING', `Asking ${door} for a line…`)
    try {
      await exchange(
        'GET',
        '/line',
        { ...auth(), accept: 'text/event-stream', 'accept-encoding': 'identity', ...(startNewSession ? { 'x-cookrew-session': 'new' } : {}) },
        '',
        (head) => {
          status = head.status
          startNewSession = false
          if (status === 200) {
            lineUp = true
            everUp = true
            reconnects = 0
            gate(null)
            $('btn-end').hidden = false
            $('prompt').disabled = false
            $('send').disabled = false
            $('bar-led').classList.remove('off')
            setOpened(`opened ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
            setPhase('LIVE', `The line is open. This is ${orch}'s own terminal.`)
            railLive(true)
            term.focus()
            startRailPolling()
          }
        },
        (chunk) => {
          if (status !== 200) {
            refusal += chunk
            return
          }
          sse += chunk
          let sep
          while ((sep = sse.indexOf('\n\n')) !== -1) {
            const block = sse.slice(0, sep)
            sse = sse.slice(sep + 2)
            if (!block || block.startsWith(':')) continue
            let event = 'message'
            let data = ''
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
            }
            if (!data) continue
            const payload = jsonOf(data)
            if (event === 'data' && typeof payload === 'string') term.write(payload)
            else if (event === 'hello') void resize()
            else if (event === 'exit') note('— the orch process exited —')
          }
        },
        controller.signal
      )
    } catch (error) {
      if (controller.signal.aborted) return
      lineUp = false
      if (error instanceof LineError && error.kind === 'not-serving') {
        note(`— ${door} is not serving this team. Nothing was charged; the address works again when they start it. —`)
        setPhase('OFFLINE', `Nobody is serving ${door} right now.`)
        stop()
        return
      }
      note(`✕ ${error.message} — retrying`)
      scheduleReconnect(4000)
      return
    }
    if (status !== 200) {
      lineUp = false
      await refused(status, jsonOf(refusal))
      return
    }
    lineUp = false
    scheduleReconnect(1200)
  }

  async function refused(status, body) {
    if (status === 401) {
      try {
        await signIn()
        return connectLine()
      } catch (error) {
        note(`✕ ${error.message}`)
        setPhase('SIGNED OUT', error.message)
        gate('Sign in', error.message, [button('🔑 Try again', true, () => void open())])
        return
      }
    }
    if (status === 402) {
      if (everUp) {
        note(`— the session ended at ${door}'s app. Nothing you typed was lost. Start a new one below. —`)
        setPhase('ENDED', 'Your session here is over.')
        stop()
        return
      }
      return pay(body)
    }
    if (status === 410) {
      note(`— this session ended at ${door}'s app. Press Enter here to start a new one. —`)
      awaitingNewSession = true
      closed = true
      setPhase('ENDED', 'Your session here is over. Press Enter to start a new one, or leave it.')
      railLive(false)
      $('btn-end').hidden = true
      $('btn-new').hidden = false
      return
    }
    if (status === 404) {
      note(`— ${door} is not serving this team. Nothing was charged. —`)
      setPhase('OFFLINE', `Nobody is serving ${door} right now.`)
      stop()
      return
    }
    if (status === 429) {
      note(`✕ ${body?.error ?? "the door is over its owner's lending limit"}`)
      setPhase('FULL', "The owner's lending limit is reached; try again later.")
      scheduleReconnect(15000)
      return
    }
    if (status === 403) {
      note(`✕ not covered: ${body?.reason ?? 'refused'}`)
      setPhase('REFUSED', 'This account is not covered at this door.')
      stop()
      return
    }
    note(`✕ line refused (${status})${body?.error ? `: ${body.error}` : ''} — retrying`)
    scheduleReconnect(4000)
  }

  /* ── money: card through the door's checkout, wallet not on the web yet ─── */
  async function pay(body) {
    const terms = body?.terms
    const price = root.dataset.price
    if (body?.reason === 'invalid') {
      gate('Payment refused', 'The door did not accept that payment. Nothing was charged twice.', [button('Try again', true, () => void open())])
      return
    }
    if (body?.reason === 'unverifiable') {
      gate('Payment could not be verified', 'The door could not confirm the payment right now; it may be confirmed shortly.', [button('Retry', true, () => void connectLine())])
      return
    }
    const accepts = Array.isArray(terms?.accepts) ? terms.accepts : []
    const card = accepts.find((a) => a?.scheme === 'stripe-checkout')
    const wallet = accepts.find((a) => a?.scheme === 'exact')
    const actions = []
    if (card) {
      actions.push(
        button(`Pay ${price} USD by card`, true, async () => {
          const res = await exchange('POST', '/api/call/pay', { ...auth(), 'content-type': 'application/json' }, '{}')
          const out = jsonOf(res.body)
          if (res.status !== 200 || !out?.url) {
            toast(`Card payment is not available right now (${res.status}).`, 5000)
            return
          }
          if (!STRIPE_CHECKOUT.test(out.url)) {
            toast('The door offered a checkout that is not Stripe’s; refusing to open it.', 6000)
            return
          }
          const session = /\/(cs_[A-Za-z0-9_]+)/.exec(out.url)?.[1]
          window.open(out.url, '_blank', 'noopener')
          if (session) {
            payment = btoa(JSON.stringify({ rail: 'stripe', session }))
            gate('Finish paying in the other tab', 'When the checkout completes, open the line.', [button('Open the line', true, () => void connectLine())])
          }
        })
      )
    }
    if (wallet) {
      actions.push(button('USDC · wallet', false, () => toast('Wallet payment is not wired on the web yet — open this team in Cookrew to pay with USDC.', 6000)))
    }
    setPhase('PAY', `This team charges ${price} USD per session, once, at the start.`)
    gate('This team charges per session', `${price} USD, charged once when the session starts — never per question. An open session is never interrupted for money.`, actions.length > 0 ? actions : [button('Open in Cookrew to pay', true, () => (location.href = `cookrew://import/${door}`))])
  }

  /* ── keystrokes, geometry, the rail ────────────────────────────────────── */
  async function post(path, body) {
    let res = await exchange('POST', path, { ...auth(), 'content-type': 'application/json' }, JSON.stringify(body))
    if (res.status === 401 || res.status === 403) {
      await signIn()
      res = await exchange('POST', path, { ...auth(), 'content-type': 'application/json' }, JSON.stringify(body))
    }
    if (res.status === 404) {
      note('— the session at the door ended; reopening the line —')
      scheduleReconnect(500)
    } else if (res.status !== 200) note(`✕ refused (${res.status})`)
    return res
  }
  const resize = () => {
    fit?.fit()
    return post('/line/resize', { cols: term.cols, rows: term.rows })
  }
  term.onData((data) => {
    if (awaitingNewSession && /[\r\n]/.test(data)) return startNew()
    if (!lineUp) return
    void post('/line/raw', { data })
  })
  window.addEventListener('resize', () => {
    if (lineUp) void resize()
  })
  const send = () => {
    const input = $('prompt')
    const text = input.value
    if (!text || !lineUp) return
    input.value = ''
    void post('/line/raw', { data: `${text}\r` })
    term.focus()
  }
  $('send').addEventListener('click', send)
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      send()
    }
  })

  const span = (cls, text) => {
    const el = document.createElement('span')
    el.className = cls
    el.textContent = text
    return el
  }
  async function rail() {
    let res
    try {
      res = await exchange('GET', '/turns?limit=40', auth(), '')
    } catch {
      return
    }
    if (res.status !== 200) return
    const page = jsonOf(res.body)
    const turns = Array.isArray(page) ? page : page?.turns
    if (!Array.isArray(turns)) return
    const total = Array.isArray(page) ? turns.length : page.total
    if (total === turnsSeen) return
    turnsSeen = total
    $('rail-n').textContent = String(total)
    const list = $('rail')
    const tail = $('rail-tail')
    list.querySelectorAll('li[data-index]').forEach((li) => li.remove())
    for (const t of turns) {
      // The door's JSON is untrusted: numbers are checked, strings become text.
      if (!Number.isInteger(t?.index) || t.index < 0) continue
      const li = document.createElement('li')
      li.dataset.index = String(t.index)
      const title = String(t.title || t.prompt || '(empty prompt)').split('\n')[0].slice(0, 80)
      li.append(span('n', String(t.index)), span('t', title))
      li.addEventListener('click', () => void showBlock(t.index, li))
      list.insertBefore(li, tail)
    }
    if (turns.length > 0) setPhase('REPLIED', `Turn ${turns[turns.length - 1].index} saved; the rail has it.`)
  }
  async function showBlock(index, li) {
    $('rail').querySelectorAll('li').forEach((x) => x.classList.remove('focus'))
    li.classList.add('focus')
    const res = await exchange('GET', `/trace?aroundIndex=${index}&limit=1`, auth(), '')
    const page = jsonOf(res.body)
    const block = page?.blocks?.find((b) => b.index === index) ?? page?.blocks?.[0]
    const out = $('block')
    if (!block) {
      out.textContent = 'This turn has no trace block at the door.'
    } else {
      const tools = (block.activity ?? []).map((a) => `  ⏺ ${a.tool}(${a.args})${a.result ? ` → ${a.result}` : ''}`).join('\n')
      out.textContent = `❯ ${block.prompt}\n${tools ? `${tools}\n` : ''}${block.reply}`
    }
    out.hidden = false
  }
  const railLive = (live) => {
    const tail = $('rail-tail')
    tail.classList.toggle('ended', !live)
    tail.querySelector('.t').innerHTML = `<span class="dot"></span>${live ? 'LIVE' : 'ENDED'}`
  }
  const startRailPolling = () => {
    clearInterval(pollTimer)
    void rail()
    pollTimer = setInterval(() => {
      if (lineUp) void rail()
    }, 3000)
  }

  /* ── lifecycle ─────────────────────────────────────────────────────────── */
  let reconnectPending = false
  let reconnects = 0
  function scheduleReconnect(delay) {
    if (closed || reconnectPending) return
    if (reconnects >= RECONNECT_LIMIT) {
      note('— the line stayed down; not retrying on its own. Open it again when you are back. —')
      setPhase('DOWN', 'The line stayed down.')
      stop()
      return
    }
    reconnects += 1
    reconnectPending = true
    const wait = Math.min(RECONNECT_MAX_MS, delay * 2 ** Math.min(reconnects - 1, 6))
    setTimeout(() => {
      reconnectPending = false
      void connectLine()
    }, wait)
  }
  function stop() {
    closed = true
    lineUp = false
    clearInterval(pollTimer)
    $('btn-end').hidden = true
    $('prompt').disabled = true
    $('send').disabled = true
    $('bar-led').classList.add('off')
    railLive(false)
  }
  async function open() {
    if (!relayed) return toast('This door is not on the relay; open it in Cookrew.')
    reconnects = 0
    const acct = account()
    if (!(await acct?.handle())) {
      toast('Sign in to cookrew.dev first — the door lends to accounts.')
      return acct?.signIn()
    }
    closed = false
    gate(null)
    term.clear()
    note(`cookrew.dev · web line · sealed to ${door}'s key, carried by the relay, decrypted only at the owner's machine.`)
    try {
      const who = await signIn()
      note(`signed in as @${who} · asking for a line`)
    } catch (error) {
      note(`✕ ${error.message}`)
      setPhase('SIGNED OUT', error.message)
      gate('Sign in', error.message, [button('🔑 Try again', true, () => void open())])
      return
    }
    await connectLine()
  }
  function startNew() {
    awaitingNewSession = false
    startNewSession = true
    closed = false
    $('btn-new').hidden = true
    $('bar-led').classList.remove('off')
    note('— starting a new session…')
    void connectLine()
  }
  async function end() {
    if (!doorToken) return
    controller?.abort()
    const res = await exchange('POST', '/session/end', auth(), '')
    stop()
    note(res.status === 200 ? `— session ended by you · your workspace at ${door} is destroyed —` : '— no open session to end —')
    setPhase('ENDED', 'Your session here is over. Start a new one, or leave it.')
    awaitingNewSession = true
    $('btn-new').hidden = false
  }
  $('btn-open').addEventListener('click', () => void open())
  $('btn-new').addEventListener('click', startNew)
  $('btn-end').addEventListener('click', () => void end())
  window.addEventListener('pagehide', () => controller?.abort())
})()
