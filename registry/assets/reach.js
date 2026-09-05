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
 *   send everybody to the relay for no reason.
 *
 *   HOLDS THE PAIRING KEY. Six characters from the Mac's popout, in
 *   localStorage under `cr_pair:<deviceId>`. It never goes to cookrew.dev:
 *   reachability and authorisation are different questions (P3), and the
 *   registry answers only the second. A desktop the browser has no key for
 *   reads NEEDS PAIRING and offers to scan or to be told.
 *
 *   OPENS. A canvas token from the registry, then the desktop, with the token,
 *   the key and the device id on the query. If the desktop says 401 it sends
 *   the reader back with ?refused=key and the page says which key was wrong.
 */
;(() => {
  'use strict'
  const list = document.getElementById('me-desktops')
  if (!list) return

  const PAIR_KEY = /^[2-9A-HJ-NP-Z]{6}$/
  const QR = /^cookrew-pair:([0-9a-f-]{36}):([2-9A-HJ-NP-Z]{6})$/
  const PROBE_MS = 800
  const username = document.getElementById('me')?.dataset.username ?? ''
  const toast = (text, ms) => window.cookrewAccount?.toast?.(text, ms ?? 5000)

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
    show('[data-forget-pair]', paired)
    show('[data-pair-note]', !paired)
    show('[data-type-key]', !paired)
    // No BarcodeDetector, no button: an action that cannot work is worse than
    // an action that is not offered.
    show('[data-scan]', !paired && typeof window.BarcodeDetector === 'function')
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
    // The relay is not probed: it is available or it is not, and asking
    // cookrew.dev to hold a connection open just to draw a badge is a cost
    // with no answer in it.
    if (reach.relay === true) return { state: 'relay', url: null }
    return { state: 'offline', url: null }
  }

  const chosen = new Map()

  async function refresh(row) {
    const deviceId = row.dataset.desktop
    const paired = keyFor(deviceId) !== null
    actions(row, paired)
    if (!paired) {
      badge(row, 'pairing')
      return
    }
    badge(row, 'probing')
    let reach = {}
    try {
      reach = JSON.parse(row.dataset.reach ?? '{}')
    } catch {
      reach = {}
    }
    const found = await pathFor(deviceId, reach)
    chosen.set(deviceId, found)
    badge(row, found.state)
  }

  /* ── opening ───────────────────────────────────────────────────────────── */
  async function open(deviceId) {
    const key = keyFor(deviceId)
    if (key === null) return
    const found = chosen.get(deviceId) ?? { state: 'offline', url: null }
    if (found.state === 'offline') {
      toast('That Mac did not answer on any address it published. It may be asleep.')
      return
    }
    const out = await post(`/v2/me/desktops/${encodeURIComponent(deviceId)}/open`)
    if (out.status !== 201 || !out.body?.token) {
      toast(out.body?.message ?? 'That Mac could not be opened just now.')
      return
    }
    const carried = `open=${encodeURIComponent(out.body.token)}&key=${encodeURIComponent(key)}`
    if (found.url !== null) {
      location.assign(`${found.url}/?${carried}&device=${encodeURIComponent(deviceId)}`)
      return
    }
    location.assign(`/relay/@${encodeURIComponent(username)}/desktop/${encodeURIComponent(deviceId)}?${carried}`)
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

  function typeKey(deviceId) {
    const typed = prompt('The six characters beside the QR on the Mac')
    if (typed === null) return
    const key = typed.trim().toUpperCase()
    if (!PAIR_KEY.test(key)) {
      toast('Six characters, letters and digits — the ones shown beside the QR.')
      return
    }
    if (!rememberKey(deviceId, key)) {
      toast('This browser would not remember the key. Allow storage for cookrew.dev and try again.')
      return
    }
    const row = rowFor(deviceId)
    if (row) void refresh(row)
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */
  list.addEventListener('click', (event) => {
    const el = event.target.closest('[data-open-desktop],[data-scan],[data-type-key],[data-forget-pair]')
    if (!el) return
    event.preventDefault()
    if (el.dataset.openDesktop !== undefined) void open(el.dataset.openDesktop)
    else if (el.dataset.scan !== undefined) void scan(el.dataset.scan)
    else if (el.dataset.typeKey !== undefined) typeKey(el.dataset.typeKey)
    else if (el.dataset.forgetPair !== undefined) {
      forgetKey(el.dataset.forgetPair)
      const row = rowFor(el.dataset.forgetPair)
      if (row) void refresh(row)
    }
  })

  // Sent back by a desktop that refused the key. The Mac rotates it every two
  // minutes, so the answer is almost always "scan it again", not "you are not
  // allowed" — and the sentence says which.
  const refused = new URLSearchParams(location.search).get('refused')
  if (refused === 'key') {
    const note = document.getElementById('reach-refused')
    if (note) note.hidden = false
  }

  for (const row of rows()) void refresh(row)
})()
