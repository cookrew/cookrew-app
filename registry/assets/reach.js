/* cookrew.dev — THE DESKTOP PICKER (M3): which Mac, which path, which key.
 *
 * The server sent every state this page can be in. This script does three
 * things and nothing else:
 *
 *   RACES THE PATHS. For each address the desktop published, one `/api/hello`
 *   with a fresh nonce and an 800 ms budget; the reply's signature is checked
 *   by the registry (only it holds the device's public key). First verified
 *   answer wins in the order LAN → TAILNET → RELAY → OFFLINE. A proxy, a CORS
 *   refusal or a TLS failure is "NOT THIS PATH", never "desktop down" — the
 *   system proxy on this machine does not bypass 100.64/10 or *.ts.net, so a
 *   browser fails where curl succeeds, and reading that as "offline" would
 *   send everybody to the relay for no reason. The relay is the LAST
 *   candidate and it is not probed but ASKED: only cookrew.dev knows whether
 *   that Mac is holding a line, and it answers in one cheap request.
 *
 *   REMEMBERS THE WINNER, per desktop, and re-races it. The path is a fact
 *   about THIS network and a phone changes network in a pocket, so the memory
 *   is a hint that fills the badge instantly and is overwritten by every
 *   probe — on `online`, when the tab comes forward, and once a minute.
 *
 *   HOLDS THE PAIRING KEY. Six characters from the Mac's popout, in
 *   localStorage under `cr_pair:<deviceId>`. It never goes to cookrew.dev:
 *   reachability and authorisation are different questions (P3), and the
 *   registry answers only the second. A desktop the browser has no key for
 *   reads NEEDS PAIRING and offers to scan or to be told.
 *
 *   OPENS. A canvas token from the registry, then the desktop, with the token,
 *   the pairing key, and THIS PHONE's device id and name on the query — the
 *   token names both ends and the desktop matches `device` against the `dev`
 *   claim, so naming the Mac there refuses a hand-off whose signature was
 *   fine. Refused, the reader comes back with ?refused=key (the six
 *   characters moved on) or ?refused=device (the link named the Mac), and the
 *   page shows the one sentence that says what to do next.
 */
;(() => {
  'use strict'
  const list = document.getElementById('me-desktops')
  if (!list) return

  const PAIR_KEY = /^[2-9A-HJ-NP-Z]{6}$/
  const QR = /^cookrew-pair:([0-9a-f-]{36}):([2-9A-HJ-NP-Z]{6})$/
  const PROBE_MS = 800
  /** How often the paths are raced again while the picker is on screen. */
  const REPROBE_MS = 60000
  /** How long a remembered path is worth showing before it is only a guess. */
  const PATH_TTL_MS = 5 * 60 * 1000
  const me = document.getElementById('me')
  const username = me?.dataset.username ?? ''
  const toast = (text, ms) => window.cookrewAccount?.toast?.(text, ms ?? 5000)

  /**
   * WHO IS ASKING — this phone, never the Mac.
   *
   * A canvas token names both ends: `aud` is the desktop it opens and `dev`
   * is the device that asked for it. The desktop checks `dev` against the
   * `device` on the query, so handing it the DESKTOP's id refuses every
   * hand-off with a signature that was perfectly good.
   *
   * The id comes from the page, because the page was rendered for THIS
   * session and the token is minted against that same session's device. The
   * browser's own store is the fallback, for a page that predates the
   * attribute; it holds the same value, having derived it from the same key.
   */
  async function asking() {
    const fromPage = me?.dataset.device ?? ''
    if (fromPage !== '') return { id: fromPage, name: me?.dataset.deviceName ?? '' }
    const held = await window.cookrewAccount?.device?.()
    return held ? { id: held.id, name: held.name ?? '' } : null
  }

  /* ── the pairing key, which is this browser's and nobody else's ────────── */
  const keyFor = (id) => {
    try {
      return localStorage.getItem(`cr_pair:${id}`)
    } catch {
      return null
    }
  }
  const rememberKey = (id, key) => {
    try {
      localStorage.setItem(`cr_pair:${id}`, key)
      return true
    } catch {
      return false
    }
  }
  const forgetKey = (id) => {
    try {
      localStorage.removeItem(`cr_pair:${id}`)
    } catch {
      /* A browser with no storage simply pairs again; nothing to repair. */
    }
  }

  /* ── the path this browser last got through on ─────────────────────────
   *
   * Per desktop, so the second open does not start from an empty PROBING
   * badge. A HINT AND NEVER AN AUTHORITY: every refresh re-races the addresses
   * and overwrites it, because the thing it describes — which network this
   * phone is on — changes without telling anybody.
   */
  const rememberPath = (id, found) => {
    try {
      localStorage.setItem(`cr_path:${id}`, JSON.stringify({ kind: found.state, url: found.url, at: Date.now() }))
    } catch {
      /* A browser with no storage simply probes every time. Slower, not wrong. */
    }
  }
  const rememberedPath = (id) => {
    try {
      const held = JSON.parse(localStorage.getItem(`cr_path:${id}`) ?? 'null')
      if (!held || typeof held.kind !== 'string' || typeof held.at !== 'number') return null
      if (Date.now() - held.at > PATH_TTL_MS) return null
      return { state: held.kind, url: typeof held.url === 'string' ? held.url : null }
    } catch {
      return null
    }
  }

  /* ── the page's own switches ───────────────────────────────────────────── */
  const rows = () => [...list.querySelectorAll('li.desktop')]
  const rowFor = (id) => rows().find((row) => row.dataset.desktop === id) ?? null

  const badge = (row, state) => {
    for (const chip of row.querySelectorAll('[data-badge]')) chip.hidden = chip.dataset.badge !== state
  }
  const actions = (row, paired) => {
    const show = (selector, on) => {
      const el = row.querySelector(selector)
      if (el) el.hidden = !on
    }
    show('[data-open-desktop]', paired)
    // DISABLED as well as hidden. Hidden is a fact about the layout and a
    // stylesheet can undo it; disabled is a fact about the button, and there
    // is no key to send, so there is nothing for a click to do but fail at
    // the Mac with a sentence about pairing.
    const openButton = row.querySelector('[data-open-desktop]')
    if (openButton) openButton.disabled = !paired
    show('[data-forget-pair]', paired)
    show('[data-pair-note]', !paired)
    show('[data-type-key]', !paired)
    // No BarcodeDetector, no button: an action that cannot work is worse than
    // an action that is not offered.
    show('[data-scan]', !paired && typeof window.BarcodeDetector === 'function')
    if (paired) {
      // Paired closes the field. Unpaired LEAVES IT ALONE: the picker re-races
      // every minute, and a refresh that swept away half-typed characters
      // would be a field nobody can finish filling in on a slow network.
      show('[data-key-form]', false)
      show('[data-key-note]', false)
    }
  }

  /* ── talking to cookrew.dev ────────────────────────────────────────────── */
  const post = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    })
    let out = null
    try {
      out = res.status === 204 ? {} : await res.json()
    } catch {
      out = null
    }
    return { status: res.status, body: out }
  }

  const nonce = () => {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    let text = ''
    for (const b of bytes) text += String.fromCharCode(b)
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  /** Where this desktop is reached through cookrew.dev, when nothing else works. */
  const relayUrl = (deviceId) =>
    `/relay/@${encodeURIComponent(username)}/desktop/${encodeURIComponent(deviceId)}/`

  /**
   * IS cookrew.dev HOLDING A LINE FOR THAT MAC?
   *
   * The one question this page cannot answer for itself: a relay session is
   * not something a browser can probe without opening one, and opening one to
   * draw a badge would be a cost with no answer in it. So the registry is
   * asked, and it knows because it is the thing holding the line.
   */
  async function relayLive(deviceId) {
    try {
      const res = await fetch(`/v2/me/desktops/${encodeURIComponent(deviceId)}/relay-status`, {
        credentials: 'same-origin',
        cache: 'no-store'
      })
      if (!res.ok) return false
      const body = await res.json()
      return body?.live === true
    } catch {
      return false
    }
  }

  /**
   * One address, one answer. False for every kind of no — a timeout, a proxy,
   * a certificate this browser will not take, a reply from a different Mac —
   * because from in here they are all the same fact: not this path.
   */
  async function probe(deviceId, url) {
    const asked = nonce()
    let reply
    try {
      const res = await fetch(`${url}/api/hello?nonce=${encodeURIComponent(asked)}`, {
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(PROBE_MS)
      })
      if (!res.ok) return false
      reply = await res.json()
    } catch {
      return false
    }
    if (!reply || reply.deviceId !== deviceId || reply.nonce !== asked || typeof reply.sig !== 'string') return false
    // The signature is the registry's to check: it holds the device's public
    // key and this page does not.
    const out = await post('/v2/verify-hello', { deviceId, nonce: asked, sig: reply.sig })
    return out.status === 200 && out.body?.ok === true
  }

  /** All candidates at once; the ORDER decides, not who answered first. */
  async function pathFor(deviceId, reach) {
    const lan = (reach.lan ?? []).map((a) => a.url)
    const tailnet = reach.tailnet ? [reach.tailnet.url] : []
    const tried = await Promise.all(
      [...lan, ...tailnet].map(async (url) => ({ url, ok: await probe(deviceId, url) }))
    )
    const winner = (urls) => tried.find((t) => t.ok && urls.includes(t.url))
    const direct = winner(lan)
    if (direct) return { state: 'lan', url: direct.url }
    const over = winner(tailnet)
    if (over) return { state: 'tailnet', url: over.url }
    // Last, and only when the desktop said it keeps a line at all: a card that
    // never claimed the relay is not worth a request about it.
    if (reach.relay === true && (await relayLive(deviceId))) {
      return { state: 'relay', url: relayUrl(deviceId) }
    }
    return { state: 'offline', url: null }
  }

  const chosen = new Map()
  /** Rows whose race is still running, so a re-probe never starts a second one. */
  const racing = new Set()

  async function refresh(row) {
    const deviceId = row.dataset.desktop
    const paired = keyFor(deviceId) !== null
    actions(row, paired)
    if (!paired) {
      badge(row, 'pairing')
      return
    }
    if (racing.has(deviceId)) return
    racing.add(deviceId)
    // The remembered path fills the badge NOW rather than after a race the
    // reader has to watch. It is replaced the moment the race answers.
    const remembered = rememberedPath(deviceId)
    if (remembered !== null && !chosen.has(deviceId)) chosen.set(deviceId, remembered)
    badge(row, remembered === null ? 'probing' : remembered.state)
    let reach = {}
    try {
      reach = JSON.parse(row.dataset.reach ?? '{}')
    } catch {
      reach = {}
    }
    try {
      const found = await pathFor(deviceId, reach)
      chosen.set(deviceId, found)
      rememberPath(deviceId, found)
      badge(row, found.state)
    } finally {
      racing.delete(deviceId)
    }
  }

  /* ── opening ───────────────────────────────────────────────────────────── */
  async function open(deviceId) {
    const key = keyFor(deviceId)
    if (key === null) return
    const found = chosen.get(deviceId) ?? rememberedPath(deviceId) ?? { state: 'offline', url: null }
    if (found.state === 'offline') {
      toast('That Mac did not answer on any address it published. It may be asleep.')
      return
    }
    const out = await post(`/v2/me/desktops/${encodeURIComponent(deviceId)}/open`)
    if (out.status !== 201 || !out.body?.token) {
      toast(out.body?.message ?? 'That Mac could not be opened just now.')
      return
    }
    const phone = await asking()
    if (phone === null) {
      toast('This browser could not name itself. Sign in again and open the Mac from here.')
      return
    }
    // THE SAME ADMISSION EITHER WAY. Direct or relayed, the desktop is asked
    // the same question on the same query — the relay forwards it untouched,
    // so there is one ceremony rather than two that drift. `device` and `name`
    // are the PHONE's: they are what the desktop matches the token's `dev`
    // against and what it writes into its admitted list.
    const carried =
      `open=${encodeURIComponent(out.body.token)}&key=${encodeURIComponent(key)}` +
      `&device=${encodeURIComponent(phone.id)}` +
      (phone.name === '' ? '' : `&name=${encodeURIComponent(phone.name)}`)
    // A direct address is an ORIGIN and the relay path already ends in a
    // slash; both become `…/?open=…`.
    location.assign(`${found.state === 'relay' ? found.url : `${found.url}/`}?${carried}`)
  }

  /* ── pairing: scan the Mac's QR, or be told its six characters ─────────── */
  function scanner() {
    let dialog = document.getElementById('reach-scan')
    if (dialog) return dialog
    dialog = document.createElement('dialog')
    dialog.id = 'reach-scan'
    dialog.className = 'card'
    dialog.style.padding = '14px'
    const video = document.createElement('video')
    video.setAttribute('playsinline', '')
    video.muted = true
    video.style.cssText = 'width:min(74vw,320px);height:auto;display:block;border:2px solid var(--line)'
    const note = document.createElement('p')
    note.className = 'meta'
    note.textContent = 'Point the camera at the QR on the Mac.'
    const stop = document.createElement('button')
    stop.className = 'btn sm'
    stop.textContent = 'CANCEL'
    stop.addEventListener('click', () => dialog.close())
    dialog.append(video, note, stop)
    document.body.appendChild(dialog)
    return dialog
  }

  async function scan(deviceId) {
    const dialog = scanner()
    const video = dialog.querySelector('video')
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    } catch {
      toast('This browser would not open the camera. Type the six characters instead.')
      return
    }
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
    video.srcObject = stream
    await video.play().catch(() => undefined)
    dialog.showModal()
    let running = true
    const end = () => {
      running = false
      for (const track of stream.getTracks()) track.stop()
      video.srcObject = null
    }
    dialog.addEventListener('close', end, { once: true })
    while (running && dialog.open) {
      let found = []
      try {
        found = await detector.detect(video)
      } catch {
        found = []
      }
      for (const code of found) {
        const parsed = QR.exec((code.rawValue ?? '').trim())
        // The QR carries the desktop id and the key and nothing else — no
        // address, ever. A code for ANOTHER Mac is stored against that Mac.
        if (parsed === null) continue
        rememberKey(parsed[1], parsed[2])
        dialog.close()
        const row = rowFor(parsed[1])
        if (row) void refresh(row)
        toast(parsed[1] === deviceId ? 'Paired. Finding the best path…' : 'Paired with another Mac on this account.')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 160))
    }
  }

  /**
   * TYPE KEY opens a field in the row, not a native prompt.
   *
   * A `prompt()` is a chrome dialog with the browser's own typography sitting
   * on top of a page that has spent some care on its own; it cannot be styled,
   * cannot say why six characters were refused without a second dialog, and on
   * a phone it covers the QR the person is reading the key off. The field is
   * in the markup the server sent, so it is one `hidden` away.
   */
  function typeKey(deviceId) {
    const row = rowFor(deviceId)
    if (!row) return
    const form = row.querySelector('[data-key-form]')
    const note = row.querySelector('[data-key-note]')
    const button = row.querySelector('[data-type-key]')
    if (note) note.hidden = true
    if (form) form.hidden = false
    if (button) button.hidden = true
    row.querySelector('[data-key-input]')?.focus?.()
  }

  /** The two sentences a desktop can send a reader back with, under its own row. */
  const clearRefusal = (row) => {
    for (const selector of ['[data-refused-key]', '[data-refused-device]']) {
      const note = row.querySelector(selector)
      if (note) note.hidden = true
    }
  }
  const showRefusal = (row, reason) => {
    clearRefusal(row)
    const note = row.querySelector(reason === 'device' ? '[data-refused-device]' : '[data-refused-key]')
    if (note) note.hidden = false
  }

  /** ENTER, or LINK: the six characters become this browser's key for that Mac. */
  function linkKey(deviceId) {
    const row = rowFor(deviceId)
    if (!row) return
    const input = row.querySelector('[data-key-input]')
    const note = row.querySelector('[data-key-note]')
    const key = String(input?.value ?? '')
      .trim()
      .toUpperCase()
    if (!PAIR_KEY.test(key)) {
      // The sentence is already in the page; showing it is all there is to do.
      if (note) note.hidden = false
      input?.focus?.()
      return
    }
    if (!rememberKey(deviceId, key)) {
      toast('This browser would not remember the key. Allow storage for cookrew.dev and try again.')
      return
    }
    if (input) input.value = ''
    if (note) note.hidden = true
    clearRefusal(row)
    void refresh(row)
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */
  list.addEventListener('keydown', (event) => {
    const el = event.target.closest?.('[data-key-input]')
    if (!el) return
    // The refusal was about the LAST key. The moment a new one is being typed
    // it is stale, and a sentence that outlives what it described is a
    // sentence a reader tries to obey.
    const row = rowFor(el.dataset.keyInput)
    if (row) clearRefusal(row)
    if (event.key !== 'Enter') return
    event.preventDefault()
    linkKey(el.dataset.keyInput)
  })

  list.addEventListener('click', (event) => {
    const el = event.target.closest('[data-open-desktop],[data-scan],[data-type-key],[data-key-link],[data-forget-pair]')
    if (!el) return
    event.preventDefault()
    if (el.dataset.openDesktop !== undefined) void open(el.dataset.openDesktop)
    else if (el.dataset.scan !== undefined) void scan(el.dataset.scan)
    else if (el.dataset.typeKey !== undefined) typeKey(el.dataset.typeKey)
    else if (el.dataset.keyLink !== undefined) linkKey(el.dataset.keyLink)
    else if (el.dataset.forgetPair !== undefined) {
      forgetKey(el.dataset.forgetPair)
      const row = rowFor(el.dataset.forgetPair)
      if (row) void refresh(row)
    }
  })

  /*
   * COMING BACK REFUSED.
   *
   * The Mac rotates its six characters every two minutes, so the answer is
   * almost always "get them again" rather than "you are not allowed". Two
   * mistakes with two fixes: a key that moved on is retyped, a link that named
   * the Mac is thrown away and the Mac opened from here again.
   *
   * THE STALE KEY IS DELETED, not kept. Keeping it left the row offering OPEN
   * and sending the same refused characters at every press — a loop the reader
   * cannot see the cause of, because from the outside the button simply stops
   * working. Once it is gone the row is NEEDS PAIRING, which is true, and the
   * field is already open with the cursor in it.
   */
  const query = new URLSearchParams(location.search)
  const refused = query.get('refused')
  const refusedDesktop = (query.get('desktop') ?? '').toLowerCase()
  const refusedRow = refused === 'key' || refused === 'device' ? rowFor(refusedDesktop) : null
  if (refusedRow !== null) {
    forgetKey(refusedDesktop)
  } else if (refused === 'key' || refused === 'device') {
    // No desktop named — the page-level line is all that can honestly be said.
    const note = document.getElementById(refused === 'key' ? 'reach-refused' : 'reach-refused-device')
    if (note) note.hidden = false
  }

  /* ── re-probing, because the network moves under the page ──────────────
   *
   * The winner is a fact about the network this phone is on right now. So the
   * race runs again when the browser says it is back online, when the tab
   * comes forward, and on a slow timer for the case neither fires — a Wi-Fi
   * that swaps bands, a VPN that comes up.
   *
   * SWITCHING A SESSION THAT IS ALREADY OPEN IS NOT THIS PAGE'S JOB, and could
   * not be: the moment a canvas opens it is running on the desktop's own
   * origin, or under the relay prefix, and this picker is no longer on screen.
   * The companion switches its own live session; that is the app half.
   */
  const reprobe = () => {
    for (const row of rows()) void refresh(row)
  }
  window.addEventListener('online', reprobe)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reprobe()
  })
  setInterval(reprobe, REPROBE_MS)

  reprobe()

  // AFTER the first race, so `actions` has already drawn the row as NEEDS
  // PAIRING: the field opens on top of a row that is telling the truth, with
  // the reason under it and the cursor where the new characters go.
  if (refusedRow !== null) {
    typeKey(refusedDesktop)
    showRefusal(refusedRow, refused)
  }
})()
