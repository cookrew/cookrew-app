/*
 * cookrew.dev/me AS THE CONSOLE — the browser's half (registry/src/site-machines.ts).
 *
 * The server draws every machine of the account as what it is, with an empty
 * screen. This fills the screens, and only past the gate: the account's
 * twelve-hour pass (owner, 2026-11-09), proved here once with the password or
 * a passkey and kept where the phone's page keeps it (`cr_grant`), so a machine
 * opened from here, or from the phone's own page, asks nothing more.
 *
 * Past the gate, for each online machine, one at a time: a key at its door
 * (account-pair.ts: the pass, its challenge, this browser's own key over it),
 * kept as `cr_token:<id>` like every other key this browser holds; then its own
 * summary (/api/fleet) through the relay, drawn as workspace names and a face
 * per agent, the ones that need the owner in red. Every 15 s while the page is
 * in front. A machine that no longer takes the key is asked again next round.
 *
 * Before the gate nothing is read from any machine: no names of workspaces, no
 * faces, nothing (owner: hide workspace names too).
 */
;(() => {
  'use strict'
  const grid = document.getElementById('me-machines')
  if (!grid) return
  const username = grid.dataset.username ?? ''
  const gate = document.getElementById('me-gate')
  const gateButton = gate?.querySelector('[data-gate]')
  const gatePassword = document.getElementById('me-gate-password')
  const gateNote = document.getElementById('me-gate-note')
  const EVERY_MS = 15_000
  const GRANT_KEY = 'cr_grant'
  const TOKEN_PREFIX = 'cr_token:'
  const GRANT_MARGIN_MS = 60_000
  const SVG = 'http://www.w3.org/2000/svg'

  const store = {
    get: (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    set: (key, value) => {
      try {
        globalThis.localStorage?.setItem(key, value)
      } catch {
        /* a browser that keeps nothing asks again next time */
      }
    },
    drop: (key) => {
      try {
        globalThis.localStorage?.removeItem(key)
      } catch {
        /* nothing to drop */
      }
    }
  }
  const tokenKey = (id) => `${TOKEN_PREFIX}${String(id).toLowerCase()}`
  const relay = (id) => `/relay/@${encodeURIComponent(username)}/desktop/${encodeURIComponent(id)}/`
  const b64u = (bytes) => {
    let s = ''
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const unb64u = (text) => {
    const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  }
  const call = async (method, path, body, headers = {}) => {
    try {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      let json = null
      try {
        json = res.status === 204 ? {} : await res.json()
      } catch {
        json = null
      }
      return { status: res.status, body: json }
    } catch {
      return { status: 0, body: null }
    }
  }

  const device = async () => (await globalThis.cookrewAccount?.device?.()) ?? null

  /** The twelve-hour pass this browser holds, for this browser's own device, or null. */
  const heldGrant = async () => {
    const raw = store.get(GRANT_KEY)
    if (!raw) return null
    let grant
    try {
      grant = JSON.parse(raw)
    } catch {
      return null
    }
    const mine = await device()
    if (!mine || !grant || grant.deviceId !== mine.id || typeof grant.grant !== 'string' || grant.exp - Date.now() <= GRANT_MARGIN_MS) return null
    return grant
  }

  // ── the gate ──────────────────────────────────────────────────────────────
  const say = (text) => {
    if (!gateNote) return
    gateNote.textContent = text
    gateNote.hidden = text === ''
  }

  const passkeyAnswer = async (asked) => {
    if (!asked || !navigator.credentials?.get) return null
    try {
      const held = await navigator.credentials.get({
        publicKey: {
          challenge: unb64u(asked.challenge),
          rpId: asked.rpId,
          timeout: asked.timeout,
          userVerification: 'required',
          allowCredentials: asked.allowCredentials.map((c) => ({ type: 'public-key', id: unb64u(c.id) }))
        }
      })
      const r = held?.response
      if (!held || !r || !('authenticatorData' in r)) return null
      return { id: held.id, response: { clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature) } }
    } catch {
      return null
    }
  }

  const keepGrant = (answer) => {
    store.set(GRANT_KEY, JSON.stringify({ grant: answer.grant, exp: answer.exp, deviceId: answer.deviceId }))
    if (gate) gate.hidden = true
    say('')
    void round()
  }

  const prove = async () => {
    if (!gateButton) return
    gateButton.disabled = true
    try {
      // The password, when it is showing and typed.
      if (gatePassword && !gatePassword.hidden && gatePassword.value !== '') {
        const sent = await call('POST', '/v2/me/device-grant', { password: gatePassword.value })
        gatePassword.value = ''
        if (sent.status === 201) return keepGrant(sent.body)
        return say(sent.body?.message ?? 'That did not work. Try again.')
      }
      const options = await call('POST', '/v2/me/device-grant/options', {})
      if (options.status !== 200) return say(options.body?.message ?? 'cookrew.dev did not answer. Try again.')
      if (options.body?.needsPassword) return say('Set an account password or add a passkey below first.')
      if (options.body?.passkey) {
        const credential = await passkeyAnswer(options.body.passkey)
        if (credential) {
          const sent = await call('POST', '/v2/me/device-grant', { credential })
          if (sent.status === 201) return keepGrant(sent.body)
          say(sent.body?.message ?? 'That passkey did not answer.')
        }
      }
      if (options.body?.methods?.password && gatePassword) {
        gatePassword.hidden = false
        gatePassword.focus()
        gateButton.textContent = 'Go'
      }
    } finally {
      gateButton.disabled = false
    }
  }
  gateButton?.addEventListener('click', () => void prove())
  gatePassword?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void prove()
  })

  // ── past the gate: a key at each door, then its summary ───────────────────
  /** This browser into one machine with the pass: its key, or null. Signs only for the machine it meant. */
  const enter = async (id, grant) => {
    const mine = await device()
    const sign = globalThis.cookrewAccount?.doorSign
    if (!mine || !sign) return null
    const asking = { deviceId: mine.id, jwk: mine.jwk, name: mine.name }
    const begun = await call('POST', `${relay(id)}api/pair/begin`, { device: asking, grant: grant.grant })
    const challenge = begun.body
    // Its own id, exactly, and a challenge in the shape the door hands out; signed with the id this page meant.
    if (begun.status !== 200 || !challenge || challenge.desktopId !== id) return null
    if (typeof challenge.challengeId !== 'string' || typeof challenge.nonce !== 'string') return null
    const sig = await sign(`cookrew-pair/2 ${id} ${challenge.challengeId} ${challenge.nonce} ${mine.id}`)
    const done = await call('POST', `${relay(id)}api/pair`, { device: asking, grant: grant.grant, challengeId: challenge.challengeId, sig })
    const answer = done.body
    if (done.status !== 200 || !answer?.ok || typeof answer.token !== 'string' || answer.desktopId !== id) return null
    store.set(tokenKey(id), answer.token)
    return answer.token
  }

  const el = (name, attrs, text) => {
    const node = document.createElementNS(SVG, name)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    if (text !== undefined) node.textContent = text
    return node
  }

  /** A machine's screen, drawn from its own summary: workspace names, a face per agent, the waiting ones red. */
  const draw = (tile, snapshot) => {
    const screen = tile.querySelector('[data-screen]')
    if (!screen) return
    const [x, y, w, h] = String(screen.dataset.screen).split(' ').map(Number)
    const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces.filter((ws) => Array.isArray(ws?.agents)) : []
    const shown = workspaces.slice(0, 3)
    const row = Math.max(14, Math.floor(h / Math.max(shown.length, 1)))
    const per = Math.max(1, Math.floor(w / 11))
    screen.replaceChildren()
    shown.forEach((ws, i) => {
      screen.append(el('text', { class: 'ms-ws', x, y: y + i * row + 8 }, String(ws.name ?? '').toUpperCase().slice(0, 18)))
      ws.agents.slice(0, per).forEach((agent, j) => {
        screen.append(el('circle', { class: agent?.phase === 'waiting' ? 'ms-face w' : 'ms-face', cx: x + 5 + j * 11, cy: y + i * row + 14, r: 4 }))
      })
    })
    const waiting = workspaces.reduce((n, ws) => n + ws.agents.filter((a) => a?.phase === 'waiting').length, 0)
    const need = tile.querySelector('[data-need]')
    if (need) {
      need.textContent = waiting > 0 ? `${waiting} need${waiting === 1 ? 's' : ''} you` : ''
      need.hidden = waiting === 0
    }
  }

  const readOne = async (tile, grant) => {
    const id = tile.dataset.machine
    let token = store.get(tokenKey(id)) ?? (await enter(id, grant))
    if (!token) return
    let read = await call('GET', `${relay(id)}api/fleet`, undefined, { authorization: `Bearer ${token}` })
    if (read.status === 401) {
      // That machine no longer takes this key: ask at its door again.
      store.drop(tokenKey(id))
      token = await enter(id, grant)
      if (!token) return
      read = await call('GET', `${relay(id)}api/fleet`, undefined, { authorization: `Bearer ${token}` })
    }
    if (read.status === 200) draw(tile, read.body)
  }

  let reading = false
  const round = async () => {
    if (reading || document.hidden) return
    reading = true
    try {
      const grant = await heldGrant()
      if (!grant) {
        if (gate) gate.hidden = false
        return
      }
      if (gate) gate.hidden = true
      // One machine at a time: a page with many machines must not flood the relay.
      for (const tile of grid.querySelectorAll('[data-machine][data-online="1"]')) {
        // One machine that answers in a shape this page cannot use does not stop the others.
        try {
          await readOne(tile, grant)
        } catch {
          /* its screen stays as it was; asked again next round */
        }
      }
    } finally {
      reading = false
    }
  }

  void round()
  setInterval(() => void round(), EVERY_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void round()
  })
})()
