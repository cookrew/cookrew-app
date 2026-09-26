/* cookrew.dev — THE DESKTOPS ROW (reach v2.1): is this Mac holding its line?
 *
 * The server sent every state this row can be in. This script does one thing:
 * it asks cookrew.dev whether each Mac is holding its relay line, and unhides
 * ONLINE or OFFLINE accordingly. PROBING is what the server ships, so a reader
 * meets an honest "asking" rather than a badge that is guessing.
 *
 * IT ASKS RATHER THAN PROBES. A relay line is not something a browser can test
 * without opening one, and opening one to draw a badge would be a cost with no
 * answer in it. Only cookrew.dev knows, because cookrew.dev is the thing
 * holding the line, and it answers in one cheap request.
 *
 * NOTHING IS STORED HERE. The six-character key, the QR, the remembered path —
 * all of it belonged to a ceremony that is gone. A phone is paired on the
 * phone, on its own "Not paired" card, with the token the Mac prints; this
 * page never holds a credential for anybody's Mac.
 *
 * OPEN IS NOT WIRED. It is an anchor in the markup the server sent, pointing
 * at /relay/@user/desktop/<id>/ with nothing on the query, so it works with
 * this script broken, disabled or still loading — and it never leaves
 * cookrew.dev.
 *
 * USE WI-FI (M5, R2) IS THE ONE THING IT DOES STORE, and the sentence above
 * about never holding a credential is now narrower rather than false: this
 * page holds a token for a Mac the OWNER OF THAT MAC just allowed, arriving
 * sealed to this device's own key. cookrew.dev carried the envelope and could
 * not read it. The old sentence was about the page taking a credential from a
 * reader who had typed it somewhere else, which it still never does.
 *
 * A TAP ON THE MAC, NEVER A SCAN. The phone asks; the Mac's owner says ALLOW
 * there; the pairing URL comes back through the queue sealed to this device.
 * Nothing about it is a QR, and nothing about it leaves cookrew.dev — the
 * reach v2.1 rule holds through the whole ceremony.
 */
;(() => {
  'use strict'
  const list = document.getElementById('me-desktops')
  if (!list) return

  /** How often the badge is asked again while the page is on screen. */
  const REASK_MS = 60000
  /** How often a request that is out gets asked about. */
  const POLL_MS = 2000

  const rows = () => [...list.querySelectorAll('li.desktop')]

  const badge = (row, state) => {
    for (const chip of row.querySelectorAll('[data-badge]')) chip.hidden = chip.dataset.badge !== state
  }

  /**
   * IS cookrew.dev HOLDING A LINE FOR THAT MAC?
   *
   * Every kind of no is the same no from in here — a refusal, a network that
   * dropped, an answer that was not JSON. None of them mean the Mac is up, and
   * a badge that says ONLINE on a request that failed is worse than one that
   * says OFFLINE on a Mac that is fine: the first sends a reader to a dead
   * page, the second sends them to look at the Mac.
   */
  async function live(deviceId) {
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

  /** Rows whose question is still out, so a re-ask never sends a second one. */
  const asking = new Set()

  async function refresh(row) {
    const deviceId = row.dataset.desktop
    if (deviceId === undefined || asking.has(deviceId)) return
    asking.add(deviceId)
    try {
      const up = await live(deviceId)
      // LAN OUTRANKS ONLINE and must survive the re-ask. Both are true at
      // once — the Mac is holding its line AND this device has its token —
      // and the badge answers one question, which is how this page reaches
      // that Mac. Letting the timer overwrite LAN with ONLINE would take the
      // better answer away every sixty seconds.
      badge(row, up ? (readToken(deviceId) === null ? 'online' : 'lan') : 'offline')
    } finally {
      asking.delete(deviceId)
    }
  }

  /*
   * ASKING AGAIN, because a Mac sleeps and a network moves under the page.
   * When the browser says it is back online, when the tab comes forward, and
   * on a slow timer for the case neither fires.
   */
  const reask = () => {
    for (const row of rows()) void refresh(row)
  }
  window.addEventListener('online', reask)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reask()
  })
  setInterval(reask, REASK_MS)

  /* ── M5: USE WI-FI ─────────────────────────────────────────────────────── */

  /**
   * WHERE THIS MAC'S TOKEN LIVES — `cr_token:<desktop id>`, the key
   * src/renderer/src/pairing-scope.ts reads under the relay prefix.
   *
   * ONE ORIGIN NOW HOSTS MANY MACS: cookrew.dev serves this page AND the
   * companion for every desktop the owner has, so a single key would hand Mac
   * B a token minted for Mac A. That is not a 401 that reads as "randomly
   * unpaired"; it is a credential sent to a machine it was never minted for.
   * Keyed by desktop here for exactly the reason it is keyed by desktop there.
   */
  const TOKEN_PREFIX = 'cr_token:'
  const tokenKey = (deviceId) => `${TOKEN_PREFIX}${String(deviceId).toLowerCase()}`

  /** Storage can be refused; a refusal means "no token", never a broken page. */
  const readToken = (deviceId) => {
    try {
      return globalThis.localStorage?.getItem(tokenKey(deviceId)) ?? null
    } catch {
      return null
    }
  }
  const writeToken = (deviceId, token) => {
    try {
      globalThis.localStorage?.setItem(tokenKey(deviceId), token)
      return readToken(deviceId) === token
    } catch {
      return false
    }
  }

  /**
   * The shape the Mac mints — `randomBytes(24).toString('base64url')`.
   * Mirrors PAIRING_TOKEN_SHAPE in pairing-scope.ts; a test holds the two
   * equal, because a token refused here and accepted there is a phone that
   * pairs on the Mac and not on the page.
   */
  const PAIRING_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/

  /**
   * The token inside whatever the Mac sealed — the same three forms
   * `tokenFromInput` (src/renderer/src/auth-gate.ts) lifts, because this is
   * the same credential arriving by a different road. A URL carrying neither
   * `?token=` nor `#pair=` is null rather than treated as a bare token: a
   * plaintext that is not a pairing URL is a bug to notice, not a credential
   * to store and have the Mac refuse one screen later.
   */
  function tokenFromInput(raw) {
    const trimmed = String(raw ?? '').trim()
    if (trimmed.length === 0) return null
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const url = new URL(trimmed)
        const fromQuery = url.searchParams.get('token')
        if (fromQuery && fromQuery.length > 0) return fromQuery
        const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
        const body = hash.startsWith('/') ? hash.slice(1) : hash
        const found = new URLSearchParams(body).get('pair')
        return found && PAIRING_TOKEN_SHAPE.test(found) ? found : null
      } catch {
        return null
      }
    }
    return /[\s/]/.test(trimmed) ? null : trimmed
  }

  const say = (row, text) => {
    const note = row.querySelector('[data-reach-note]')
    if (!note) return
    note.textContent = text
    note.hidden = text === ''
  }

  /** Ask · asked · allowed — one of the three, never two. */
  const phase = (row, state) => {
    const ask = row.querySelector('[data-reach]')
    const cancel = row.querySelector('[data-reach-cancel]')
    const ok = row.querySelector('[data-reach-ok]')
    if (ask) ask.hidden = state !== 'ask'
    if (cancel) cancel.hidden = state !== 'asked'
    if (ok) ok.hidden = state !== 'allowed'
  }

  const copy = (name, text) => String(text ?? '').replace('{device}', name)

  /** Rows that already hold a token: LAN before the first badge request. */
  const settle = (row) => {
    const deviceId = row.dataset.desktop
    if (!deviceId) return false
    if (readToken(deviceId) === null) return false
    phase(row, 'allowed')
    badge(row, 'lan')
    return true
  }

  /** A request in flight, per row, so a re-render cannot start a second one. */
  const inFlight = new Map()

  async function ask(row) {
    const deviceId = row.dataset.desktop
    const name = row.dataset.name ?? 'That Mac'
    if (!deviceId || inFlight.has(deviceId)) return
    const device = await globalThis.cookrewAccount?.device?.()
    // A device key from before M5 cannot receive a sealed token. Say which
    // door is still open rather than asking for something it cannot finish.
    if (!device || device.jwk?.kty !== 'EC') {
      say(row, list.dataset.noSeal ?? '')
      return
    }
    phase(row, 'asked')
    say(row, list.dataset.asked ?? '')
    const opened = await api('POST', `/v2/me/desktops/${encodeURIComponent(deviceId)}/reach-requests`)
    if (opened.status !== 201 || !opened.body?.id) {
      phase(row, 'ask')
      say(row, opened.body?.message ?? 'That Mac could not be asked. Try again in a moment.')
      return
    }
    inFlight.set(deviceId, opened.body.id)
    poll(row, opened.body.id)
  }

  /**
   * THE ANSWER IS COLLECTED, NOT PUSHED. The sealed URL is handed to the
   * asking device ONCE and forgotten (v2-requests.ts · getRequest), so this
   * polls until it has it and stops the moment it does — a missed answer is
   * one the registry no longer holds.
   */
  function poll(row, requestId) {
    const deviceId = row.dataset.desktop
    const name = row.dataset.name ?? 'That Mac'
    const stop = setInterval(async () => {
      if (inFlight.get(deviceId) !== requestId) {
        clearInterval(stop)
        return
      }
      const out = await api('GET', `/v2/me/requests/${encodeURIComponent(requestId)}`)
      if (out.status !== 200) return
      const state = out.body?.state
      if (state === 'pending') return
      clearInterval(stop)
      inFlight.delete(deviceId)
      if (state === 'declined') {
        phase(row, 'ask')
        say(row, copy(name, list.dataset.declined))
        return
      }
      if (state !== 'allowed' || !out.body.sealed) {
        phase(row, 'ask')
        say(row, 'That answer did not arrive. Ask again.')
        return
      }
      await land(row, requestId, out.body.sealed)
    }, POLL_MS)

    const cancel = row.querySelector('[data-reach-cancel]')
    if (cancel) {
      cancel.addEventListener(
        'click',
        () => {
          clearInterval(stop)
          inFlight.delete(deviceId)
          phase(row, 'ask')
          say(row, '')
        },
        { once: true }
      )
    }
  }

  /**
   * OPEN THE ENVELOPE HERE, in the page, with this device's own key — the one
   * part of the ceremony cookrew.dev is deliberately unable to perform.
   */
  async function land(row, requestId, sealed) {
    const deviceId = row.dataset.desktop
    const name = row.dataset.name ?? 'That Mac'
    const key = await globalThis.cookrewAccount?.sealKey?.()
    const plain = key ? await globalThis.CookrewDeviceSeal?.open(key, `reach:${requestId}`, sealed) : null
    const token = plain === null || plain === undefined ? null : tokenFromInput(plain)
    if (token === null) {
      phase(row, 'ask')
      say(row, list.dataset.noSeal ?? '')
      return
    }
    if (!writeToken(deviceId, token)) {
      phase(row, 'ask')
      say(row, 'This browser would not keep the token. OPEN still works.')
      return
    }
    phase(row, 'allowed')
    badge(row, 'lan')
    say(row, copy(name, list.dataset.allowed))
  }

  const api = async (method, path) => {
    try {
      const res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store' })
      let body = null
      try {
        body = res.status === 204 ? {} : await res.json()
      } catch {
        body = null
      }
      return { status: res.status, body }
    } catch {
      return { status: 0, body: null }
    }
  }

  list.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-reach]')
    if (!trigger) return
    const row = trigger.closest('li.desktop')
    if (row) void ask(row)
  })

  for (const row of rows()) settle(row)
  reask()
})()
