/*
 * cookrew.dev/me: THE WAY INTO THE DEVICES VIEW — the browser's half
 * (registry/src/site-machines.ts; owner 2026-11-10: "the /me web page must be
 * the desktop Devices view, the same page").
 *
 * Behind the gate (the account's twelve-hour pass, proved here once with the
 * password or a passkey and kept where every page of cookrew.dev keeps it,
 * `cr_grant`), plain /me goes on into the app's own Devices view, served by one
 * of the account's machines through the relay: the one this browser last
 * opened, else the first that is online. This browser enters that machine's
 * door first (its key, `cr_token:<id>`, is what that page is paired with), and
 * that page reads every other machine the same way, with this browser's own key
 * for each (renderer relay-machine-call.ts).
 *
 * It stays here, on the account page, when the address carries a section or a
 * return (#security, ?stepped=…), when a request is waiting to be answered, or
 * when no machine lets this browser in; "Open" on a machine goes to its view.
 * Before the gate nothing is read from any machine.
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
  const GRANT_KEY = 'cr_grant'
  const TOKEN_PREFIX = 'cr_token:'
  const GRANT_MARGIN_MS = 60_000

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

  /** A proof made on this page: the session is fresh now, so no machine's page opens without a click (security review M1). */
  let provedHere = false
  const keepGrant = (answer) => {
    provedHere = true
    store.set(GRANT_KEY, JSON.stringify({ grant: answer.grant, exp: answer.exp, deviceId: answer.deviceId }))
    if (gate) gate.hidden = true
    say('')
    void onward()
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

  const FRONT_KEY = 'cr_front_machine'
  const ZOOM_KEY = 'cookrew.zoom'
  const root = document.getElementById('me')
  /** The end of the session's fresh window, on this browser's clock: from when the page arrived. */
  const freshUntil = root?.dataset.freshMs ? performance.now() + Number(root.dataset.freshMs) : 0
  const opening = document.getElementById('me-opening')
  const rows = () => [...grid.querySelectorAll('[data-machine][data-online="1"]')]
  /** A line over the machines, past the gate (the gate's own line is hidden once a pass is held). */
  const tell = (text) => {
    if (!opening) return
    opening.textContent = text
    opening.hidden = text === ''
  }

  /** Into a machine's Devices view: the zoom at its devices stop, this page left out of the way back. */
  const go = (id) => {
    store.set(ZOOM_KEY, JSON.stringify({ dir: 'agents', v: -2 }))
    store.set(FRONT_KEY, String(id).toLowerCase())
    location.replace(relay(id))
  }

  /** This browser's key at that machine, entering its door with the pass when it holds none. */
  const keyFor = async (id, grant) => store.get(tokenKey(id)) ?? (await enter(id, grant))

  let pending = null
  const open = async (id) => {
    const grant = await heldGrant()
    if (!grant) {
      pending = id
      if (gate) gate.hidden = false
      gatePassword?.focus()
      return say('Prove it’s you once, and it opens.')
    }
    if (await keyFor(id, grant)) return go(id)
    tell('That machine did not let this browser in. Try again, or open another of your machines.')
  }

  /** The machine to open: the one last opened, if it is online, else the first online one. */
  const candidates = () => {
    const ids = rows().map((tile) => tile.dataset.machine)
    const front = store.get(FRONT_KEY)
    return front && ids.includes(front) ? [front, ...ids.filter((id) => id !== front)] : ids
  }

  /** Something on this page is waiting for the reader: a device or a guest asking. */
  const waiting = async () => {
    const out = await call('GET', '/v2/me/requests')
    return out.status === 200 && Array.isArray(out.body) && out.body.length > 0
  }

  const onward = async () => {
    const grant = await heldGrant()
    if (!grant) {
      if (gate) gate.hidden = false
      return
    }
    if (gate) gate.hidden = true
    if (pending) return open(pending)
    // Only plain /me goes on: a section, a return or a waiting request keeps the account page.
    if (root?.dataset.go !== 'devices' || location.hash !== '' || location.search !== '') return
    if (rows().length === 0 || (await waiting())) return
    // A session that just proved itself may add a factor or delete the account for a few minutes:
    // a machine's page is not opened in that window unless the owner chooses which (security review M1).
    if (provedHere || performance.now() < freshUntil) return tell('Choose a machine to open.')
    tell('Opening your machines…')
    for (const id of candidates()) {
      try {
        if (await keyFor(id, grant)) return go(id)
      } catch {
        /* the next one */
      }
    }
    tell('None of your machines let this browser in right now. Open one below to try again.')
  }

  grid.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('[data-open-machine]') : null
    const row = link?.closest('[data-machine]')
    if (!link || !row) return
    event.preventDefault()
    void open(row.dataset.machine)
  })

  void onward()
})()
