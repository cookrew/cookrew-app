/* cookrew.dev — the site's one script: account, stars, deep links, copy.
 *
 * ACCOUNT. A cookrew.dev account is a handle plus a key this browser holds.
 * The key never leaves the browser (a non-extractable WebCrypto key in
 * IndexedDB); signing in is the registry's own ceremony — the same one the
 * app performs with node:crypto — and it mints a short-lived token. There is
 * no password and nothing to reset: a handle is taken by the first key that
 * enrols it, on any device.
 *
 * Exposed as window.cookrewAccount for line.js: token(scope, aud), handle().
 */
;(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const enc = new TextEncoder()

  /* ── base64url ─────────────────────────────────────────────────────────── */
  const b64u = (bytes) => {
    let s = ''
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const unb64u = (text) => {
    const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const sha256 = (bytes) => crypto.subtle.digest('SHA-256', bytes)
  const concat = (...parts) => {
    const total = parts.reduce((n, p) => n + p.byteLength, 0)
    const out = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      out.set(new Uint8Array(p), at)
      at += p.byteLength
    }
    return out
  }

  /* ── toast ─────────────────────────────────────────────────────────────── */
  const toast = (message, ms = 3200) => {
    const t = $('toast')
    if (!t) return
    t.textContent = message
    t.hidden = false
    clearTimeout(t._k)
    t._k = setTimeout(() => (t.hidden = true), ms)
  }

  /* ── the key, in IndexedDB ─────────────────────────────────────────────── */
  const DB = 'cookrew-account'
  const openDb = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('keys')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  const idb = async (mode, fn) => {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', mode)
      const store = tx.objectStore('keys')
      const req = fn(store)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
  }
  const loadAccount = () => idb('readonly', (s) => s.get('account'))
  const saveAccount = (value) => idb('readwrite', (s) => s.put(value, 'account'))
  const forgetAccount = () => idb('readwrite', (s) => s.delete('account'))

  /** Ed25519 where the browser has it (the app's own algorithm), else P-256. */
  async function mintKey() {
    try {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
      return { alg: 'Ed25519', pair }
    } catch {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      return { alg: 'P-256', pair }
    }
  }

  /** WebCrypto ECDSA gives raw r‖s; the registry verifies DER. */
  const derSignature = (raw) => {
    const half = raw.byteLength / 2
    const int = (bytes) => {
      let i = 0
      while (i < bytes.length - 1 && bytes[i] === 0) i++
      const body = bytes.slice(i)
      return body[0] & 0x80 ? [0x02, body.length + 1, 0x00, ...body] : [0x02, body.length, ...body]
    }
    const r = int(new Uint8Array(raw.slice(0, half)))
    const s = int(new Uint8Array(raw.slice(half)))
    return new Uint8Array([0x30, r.length + s.length, ...r, ...s])
  }

  async function sign(account, bytes) {
    if (account.alg === 'Ed25519') return crypto.subtle.sign({ name: 'Ed25519' }, account.pair.privateKey, bytes)
    const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, account.pair.privateKey, bytes)
    return derSignature(raw)
  }

  /* ── the ceremony ──────────────────────────────────────────────────────── */
  const api = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    })
    let json = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    return { status: res.status, body: json }
  }

  async function assertion(account, scope, aud) {
    const challenge = await api('/v1/identity/challenge')
    if (challenge.status !== 200 || !challenge.body?.challenge) throw new Error('the registry issued no challenge')
    const clientDataJSON = enc.encode(
      JSON.stringify({ type: 'webauthn.get', origin: location.origin, challenge: challenge.body.challenge })
    )
    const authenticatorData = concat(await sha256(enc.encode(location.hostname)), new Uint8Array([0x01, 0, 0, 0, 1]))
    const signature = await sign(account, concat(authenticatorData, await sha256(clientDataJSON)))
    return {
      credentialId: account.handle,
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authenticatorData),
      signature: b64u(signature),
      scope,
      ...(aud ? { aud } : {})
    }
  }

  const tokens = new Map()
  const claimsOf = (token) => {
    try {
      return JSON.parse(new TextDecoder().decode(unb64u(token.split('.')[0])))
    } catch {
      return null
    }
  }
  const setCookie = (token) => {
    const claims = claimsOf(token)
    const maxAge = claims ? Math.floor((claims.exp - Date.now()) / 1000) : 0
    if (maxAge <= 0) return false
    document.cookie = `cr_account=${token}; Path=/; Max-Age=${maxAge}; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`
    return /(^|; )cr_account=/.test(document.cookie)
  }

  /** A token for a scope (and a door, for `call`), minted on demand, reused while fresh. */
  async function token(scope, aud) {
    const account = await loadAccount()
    if (!account) return null
    const key = `${scope}|${aud ?? ''}`
    const held = tokens.get(key)
    if (held && (claimsOf(held)?.exp ?? 0) > Date.now() + 15_000) return held
    const out = await api('/v1/identity/assert', await assertion(account, scope, aud))
    if (out.status !== 200 || !out.body?.token) throw new Error('sign-in was refused — is this handle enrolled from another device?')
    tokens.set(key, out.body.token)
    if (scope === 'download') setCookie(out.body.token)
    else sessionStorage.removeItem('cr_refreshed')
    return out.body.token
  }

  async function enrol(handle) {
    const clean = handle.trim().toLowerCase().replace(/^@/, '')
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(clean)) throw new Error('a handle is 1–32 lowercase letters, digits or dashes')
    const key = await mintKey()
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', key.pair.publicKey)
    const res = await api('/v1/identity/register', { credentialId: clean, publicKeyJwk })
    if (res.status === 409) throw new Error(`@${clean} is already taken — if it is yours, it belongs to the device that enrolled it`)
    if (res.status !== 201) throw new Error(`the registry refused the enrolment (${res.status})`)
    await saveAccount({ handle: clean, alg: key.alg, pair: key.pair })
    return clean
  }

  /* ── the sign-in sheet ─────────────────────────────────────────────────── */
  function sheet() {
    let dialog = $('signin-sheet')
    if (dialog) return dialog
    dialog = document.createElement('dialog')
    dialog.id = 'signin-sheet'
    dialog.className = 'card'
    dialog.innerHTML = `<h3 style="margin-top:0">Your cookrew.dev account</h3>
<p class="meta">A handle plus a key this browser holds. No password. The first key to enrol a handle owns it.</p>
<form method="dialog" id="signin-form"><div class="row"><input id="signin-handle" placeholder="handle" autocomplete="username" spellcheck="false" style="font:14px var(--font-mono);padding:8px 10px;border:2px solid var(--line);background:var(--cream-hi);color:var(--ink);min-width:200px"><button class="btn primary" value="enrol">Enrol this browser</button><button class="btn" value="cancel">Cancel</button></div></form>
<p class="meta" id="signin-note" style="margin-top:10px"></p>`
    document.body.appendChild(dialog)
    return dialog
  }

  async function signInFlow() {
    const account = await loadAccount()
    if (account) {
      const dialog = sheet()
      const form = dialog.querySelector('#signin-form')
      form.replaceChildren()
      const row = document.createElement('div')
      row.className = 'row'
      const who = document.createElement('span')
      who.className = 'chip amber'
      who.textContent = `@${account.handle}`
      const out = document.createElement('button')
      out.className = 'btn'
      out.value = 'out'
      out.textContent = "Forget this browser's key"
      const cancel = document.createElement('button')
      cancel.className = 'btn'
      cancel.value = 'cancel'
      cancel.textContent = 'Close'
      row.append(who, out, cancel)
      form.append(row)
      dialog.querySelector('#signin-note').textContent = 'Stars and the line use this account. Forgetting the key here does not release the handle.'
      dialog.showModal()
      dialog.onclose = async () => {
        if (dialog.returnValue === 'out') {
          await forgetAccount()
          tokens.clear()
          document.cookie = 'cr_account=; Path=/; Max-Age=0'
          location.reload()
        }
      }
      return
    }
    const dialog = sheet()
    dialog.showModal()
    dialog.querySelector('#signin-handle')?.focus()
    dialog.onclose = async () => {
      if (dialog.returnValue !== 'enrol') return
      const handle = dialog.querySelector('#signin-handle')?.value ?? ''
      try {
        await enrol(handle)
        await token('download')
        toast(`Enrolled @${handle.trim().toLowerCase().replace(/^@/, '')}. Signed in.`)
        setTimeout(() => location.reload(), 600)
      } catch (error) {
        toast(error.message, 6000)
      }
    }
  }

  /* ── stars ─────────────────────────────────────────────────────────────── */
  async function star(button) {
    const [handle, name] = button.dataset.star.split('/')
    let bearer
    try {
      bearer = await token('download')
    } catch (error) {
      toast(error.message, 6000)
      return
    }
    if (!bearer) {
      toast('Sign in to star a team — one star per account.')
      signInFlow()
      return
    }
    const res = await fetch(`/v1/doors/@${handle}/${name}/star`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } })
    if (!res.ok) {
      toast(`The star did not take (${res.status}).`)
      return
    }
    const out = await res.json()
    button.classList.toggle('on', out.starred === true)
    const n = button.querySelector('span')
    if (n) n.textContent = String(out.stars)
    toast(out.starred ? 'Starred.' : 'Star removed.')
  }

  /* ── deep link ─────────────────────────────────────────────────────────── */
  function openInCookrew(target) {
    if (!/^cookrew:\/\/(import|install|serve)\//.test(target)) return
    const t0 = Date.now()
    location.href = target
    setTimeout(() => {
      if (document.visibilityState === 'visible' && Date.now() - t0 < 2400) {
        toast('Cookrew did not answer the link — get the app, then open it again.', 5000)
        location.assign('/#download')
      }
    }, 1600)
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-star],[data-open],[data-copy],[data-signin]')
    if (!el) return
    if (el.dataset.star !== undefined) {
      event.preventDefault()
      void star(el)
    } else if (el.dataset.open !== undefined) {
      event.preventDefault()
      openInCookrew(el.dataset.open)
    } else if (el.dataset.copy !== undefined) {
      event.preventDefault()
      navigator.clipboard.writeText(el.dataset.copy).then(() => toast('Address copied. Paste it into Cookrew → Import a team.'))
    } else if (el.dataset.signin !== undefined) {
      event.preventDefault()
      // The header's button is the v2 sheet now. The v1 ceremony is still
      // reachable — line.js calls it by name when a door needs the older
      // key-based sign-in — but it is no longer what a person clicks.
      if (el.dataset.signin === 'me') location.assign('/me')
      else openAccountSheet()
    }
  })

  loadAccount().then((account) => {
    const button = $('signin')
    if (button && account) button.textContent = `@${account.handle}`
    // Keep the page's idea of "who is reading" fresh: the cookie is how the
    // server renders stars and the starred tab, and it expires with the token.
    // Once per page load, and only when the cookie actually took: a browser
    // that refuses cookies must not reload forever.
    if (account && !/(^|; )cr_account=/.test(document.cookie) && !sessionStorage.getItem('cr_refreshed')) {
      sessionStorage.setItem('cr_refreshed', '1')
      token('download')
        .then(() => {
          if (/(^|; )cr_account=/.test(document.cookie)) location.reload()
        })
        .catch(() => undefined)
    }
  })

  /**
   * The door's own key-based sign-in, for a door whose app predates registry
   * tokens: the same Ed25519 key signs the door's challenge directly, and the
   * public half is enrolled there on first sight (TOFU, as orch-line.mjs does).
   * Only an Ed25519 account can do this — a P-256 key is not what the door
   * verifies with.
   */
  const doorKey = async () => {
    const account = await loadAccount()
    if (!account || account.alg !== 'Ed25519') return null
    const jwk = await crypto.subtle.exportKey('jwk', account.pair.publicKey)
    return {
      sub: account.handle,
      jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
      sign: async (text) => b64u(await sign(account, enc.encode(text)))
    }
  }
  /* ── identity v2: a username, a password, and this browser as a device ── */
  /*
   * The v1 flow above is a handle plus a key, with no password and no way
   * back if the key is lost. v2 is what a PERSON signs into: the name is
   * claimed once with a password, and this browser is one device attached to
   * it. Both live here — the old one still opens doors whose apps predate
   * accounts, and it is what `window.cookrewAccount.signIn` still means.
   *
   * The session token never touches this script. The sheet posts to
   * /v2/sessions and the SERVER sets `cr_session` HttpOnly; a token a script
   * can read is a token a script can leak.
   */
  /**
   * The device key has its OWN database (`cookrew-device`), beside the v1
   * account key's. Two stores rather than one because the two are forgotten
   * for different reasons: "forget this browser's key" drops the v1 handle and
   * must not silently detach the device from a v2 account.
   */
  const DEVICE_DB = 'cookrew-device'
  const openDeviceDb = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(DEVICE_DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('keys')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  const deviceIdb = async (mode, fn) => {
    const db = await openDeviceDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', mode)
      const req = fn(tx.objectStore('keys'))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      tx.oncomplete = () => db.close()
    })
  }
  const loadDevice = () => deviceIdb('readonly', (s) => s.get('device'))
  const saveDevice = (value) => deviceIdb('readwrite', (s) => s.put(value, 'device'))

  /**
   * A PHONE IS A DEVICE, and so is a browser (P2). Which one this is comes
   * from the user agent, because the two are the same code and only the
   * Devices list and the pairing sheet care about the difference: "iPhone"
   * reads as a thing in a pocket, "Chrome on macOS" as a window on a desk.
   */
  const MOBILE = /iPhone|iPad|Android/
  const deviceKind = () => (MOBILE.test(navigator.userAgent) ? 'phone' : 'browser')

  /** "iPhone", "Android phone", "Chrome on macOS" — what Devices will call it. */
  function deviceName() {
    const ua = navigator.userAgent
    if (/iPad/.test(ua)) return 'iPad'
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/Android/.test(ua)) return 'Android phone'
    const engine = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
    const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this computer'
    return `${engine} on ${os}`
  }

  /**
   * This browser's device: a non-extractable key minted once, and an id
   * DERIVED FROM IT rather than a fresh uuid.
   *
   * Derived because the id must not be able to drift from the key it names —
   * the desktop computes the same value from the same public key
   * (device-id.js says how), so one key is one device wherever it is seen. A
   * random uuid would have made a re-mint after a cleared store a second
   * device on the account for the same person on the same phone.
   */
  async function deviceIdentity() {
    const held = await loadDevice()
    if (held) return held
    const key = await mintKey()
    const full = await crypto.subtle.exportKey('jwk', key.pair.publicKey)
    const jwk = key.alg === 'Ed25519' ? { kty: full.kty, crv: full.crv, x: full.x } : { kty: full.kty, crv: full.crv, x: full.x, y: full.y }
    const id = await globalThis.cookrewDeviceId.deviceIdFrom(jwk)
    const device = { id, kind: deviceKind(), name: deviceName(), jwk, pair: key.pair }
    await saveDevice(device)
    return device
  }
  const devicePayload = (d) => ({ id: d.id, kind: d.kind, name: d.name, jwk: d.jwk })

  const v2 = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    let out = null
    try {
      out = res.status === 204 ? {} : await res.json()
    } catch {
      out = null
    }
    return { status: res.status, body: out }
  }

  const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
  const chip = (id, text, tone) => {
    const el = $(id)
    if (!el) return
    el.textContent = text
    el.className = `chip${tone ? ` ${tone}` : ''}`
    el.hidden = text === ''
  }

  function accountSheet() {
    const dialog = $('account-sheet')
    if (!dialog || dialog.dataset.wired === '1') return dialog
    dialog.dataset.wired = '1'
    let mode = 'signin'
    let checking = 0

    const setMode = (next) => {
      mode = next
      for (const tab of dialog.querySelectorAll('[data-acct-tab]')) {
        const on = tab.dataset.acctTab === next
        tab.classList.toggle('primary', on)
        tab.setAttribute('aria-selected', on ? 'true' : 'false')
      }
      // Every field comes back on, whatever the legacy step turned off: the
      // tabs are the way back from a name typed by mistake, and a way back
      // that leaves the fields dead is not one.
      $('acct-password').disabled = false
      $('acct-confirm').disabled = false
      $('acct-submit').disabled = false
      $('acct-confirm-row').hidden = next === 'signin'
      $('acct-username').readOnly = next === 'legacy'
      $('acct-password').setAttribute('autocomplete', next === 'signin' ? 'current-password' : 'new-password')
      $('acct-submit').textContent =
        next === 'register' ? 'Create account' : next === 'legacy' ? 'Set a password' : 'Continue'
      $('acct-lede').textContent =
        next === 'register'
          ? 'This browser becomes your first device. A username and a password — the site never asks for an email.'
          : next === 'legacy'
            ? `Set a password for @${$('acct-username').value.trim().toLowerCase()}. This browser holds the key that owns it.`
            : 'A username and a password. The site never asks for an email.'
      $('acct-message').textContent = ''
      chip('acct-username-note', '')
      chip('acct-confirm-note', '')
    }

    /**
     * A NAME FROM BEFORE PASSWORDS (phase 6).
     *
     * The name is not free and it is not somebody else's — it is this
     * person's, held by the key that enrolled it. The step is refused BEFORE
     * anything is typed when this browser does not hold that key: a password
     * field that cannot be spent is worse than a sentence saying where to go.
     */
    const toLegacy = async (username, message) => {
      $('acct-username').value = username
      setMode('legacy')
      const account = await loadAccount()
      const holds = account && account.handle === username
      $('acct-submit').disabled = !holds
      $('acct-password').disabled = !holds
      $('acct-confirm').disabled = !holds
      $('acct-message').textContent = holds
        ? (message ?? `@${username} already exists from before passwords. Set one and it stays yours.`)
        : 'This name belongs to a key on another device — set the password there, or use that device to link this one.'
      if (holds) $('acct-password').focus()
    }

    const checkName = async () => {
      const name = $('acct-username').value.trim().toLowerCase()
      if (mode !== 'register' || name === '') return chip('acct-username-note', '')
      if (!USERNAME.test(name)) return chip('acct-username-note', 'invalid', 'no')
      const mine = ++checking
      try {
        const res = await fetch(`/v2/accounts/${encodeURIComponent(name)}`, { method: 'HEAD' })
        if (mine !== checking) return
        chip('acct-username-note', res.status === 200 ? 'taken' : 'free', res.status === 200 ? 'no' : 'ok')
        $('acct-message').textContent =
          res.status === 200 ? `@${name} is someone else’s. Try another.` : 'Yours to take.'
      } catch {
        if (mine !== checking) return
        chip('acct-username-note', 'unknown')
        $('acct-message').textContent = 'cookrew.dev did not answer, so this name cannot be checked yet.'
      }
    }

    const checkPassword = () => {
      const value = $('acct-password').value
      if (value === '') return chip('acct-password-note', '')
      chip('acct-password-note', value.length < 12 ? 'weak' : 'strong', value.length < 12 ? 'no' : 'ok')
      if (mode !== 'signin' && value.length < 12) {
        $('acct-message').textContent = 'Too easy to guess. Use 12 characters or more; a sentence works.'
      }
      if ($('acct-confirm').value !== '') {
        const same = $('acct-confirm').value === value
        chip('acct-confirm-note', same ? 'matches' : 'no match', same ? 'ok' : 'no')
      }
    }

    let typing
    dialog.addEventListener('input', (event) => {
      if (event.target.id === 'acct-username') {
        clearTimeout(typing)
        typing = setTimeout(checkName, 280)
      } else if (event.target.id === 'acct-password' || event.target.id === 'acct-confirm') {
        checkPassword()
      }
    })
    dialog.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-acct-tab]')
      if (tab) {
        event.preventDefault()
        setMode(tab.dataset.acctTab)
      }
    })
    $('acct-submit').addEventListener('click', (event) => {
      event.preventDefault()
      void submit()
    })

    async function submit() {
      const username = $('acct-username').value.trim().toLowerCase()
      const password = $('acct-password').value
      const say = (text) => ($('acct-message').textContent = text)
      if (!USERNAME.test(username)) return say('A username is lowercase letters, digits and dashes, up to 32 of them.')
      if (password.length < 12) return say('Too easy to guess. Use 12 characters or more; a sentence works.')
      if (mode !== 'signin' && $('acct-confirm').value !== password) return say('The two passwords are not the same.')
      $('acct-submit').disabled = true
      say(mode === 'register' ? `Claiming @${username}…` : mode === 'legacy' ? `Setting a password for @${username}…` : 'Signing in…')
      // Set when this attempt ENDED in the legacy step, which decides for
      // itself whether the primary comes back on — a browser that does not
      // hold the key must not be handed a button that cannot work.
      let crossed = false
      try {
        const device = devicePayload(await deviceIdentity())
        const out =
          mode === 'register'
            ? await v2('POST', '/v2/accounts', { username, password, device })
            : mode === 'legacy'
              ? await migrateWithOldKey(username, password, device)
              : await v2('POST', '/v2/sessions', { username, password, device })
        if (out.status === 201) {
          dialog.close()
          location.assign('/me')
          return
        }
        // A NAME FROM BEFORE PASSWORDS, either way it is met: REGISTER is
        // told so by the 409, and SIGN IN finds out by asking, because a
        // legacy name refuses a password with the same 401 as a typo.
        if (mode === 'register' && out.status === 409 && out.body?.error === 'legacy') {
          crossed = true
          return void (await toLegacy(username, out.body?.message))
        }
        if (mode === 'signin' && out.status === 401) {
          const waiting = await v2('GET', `/v2/migrate/${encodeURIComponent(username)}`)
          if (waiting.status === 200) {
            crossed = true
            return void (await toLegacy(username, waiting.body?.message))
          }
        }
        say(out.body?.message ?? 'That did not go through. Try again in a moment.')
      } catch (error) {
        say('This browser could not reach cookrew.dev. Nothing local stops.')
      } finally {
        if (!crossed) $('acct-submit').disabled = false
      }
    }

    setMode('signin')
    return dialog
  }

  /**
   * THE CROSSING, signed by the key this browser already holds.
   *
   * The v1 ceremony, unchanged — the same `assertion()` the stars and the
   * line use — because the whole point of it is that the registry can already
   * verify it. Nothing new is enrolled and nothing old is forgotten: the key
   * stays where it is and becomes a device of the account it just made.
   */
  async function migrateWithOldKey(username, password, device) {
    const account = await loadAccount()
    if (!account || account.handle !== username) {
      return {
        status: 0,
        body: {
          message:
            'This name belongs to a key on another device — set the password there, or use that device to link this one.'
        }
      }
    }
    return v2('POST', '/v2/migrate', {
      username,
      password,
      device,
      assertion: await assertion(account, 'download')
    })
  }

  function openAccountSheet() {
    const dialog = accountSheet()
    if (!dialog) {
      void signInFlow()
      return
    }
    dialog.showModal()
    $('acct-username')?.focus()
  }

  /* ── /me: revoke, sign out, recovery codes, display name ───────────────── */
  const me = $('me')
  if (me) {
    const refresh = () => location.reload()
    document.addEventListener('click', (event) => {
      const el = event.target.closest('[data-revoke],[data-signout],[data-recovery],[data-edit-name],[data-password]')
      if (!el) return
      event.preventDefault()
      if (el.dataset.revoke !== undefined) {
        const own = el.dataset.current === '1'
        const question = own
          ? 'Sign this browser out and detach it from the account?'
          : 'This device stops opening the account within a minute. It keeps working on its own Wi-Fi until it is paired again. Revoke it?'
        if (!confirm(question)) return
        void v2('DELETE', `/v2/me/devices/${encodeURIComponent(el.dataset.revoke)}`).then((out) => {
          if (out.status === 204) return own ? location.assign('/') : refresh()
          toast(out.body?.message ?? 'That device could not be revoked.', 6000)
        })
      } else if (el.dataset.signout !== undefined) {
        void v2('POST', '/v2/sessions/current').then(() => location.assign('/'))
      } else if (el.dataset.recovery !== undefined) {
        if (!confirm('A new set of eight codes replaces any you already have. Show them?')) return
        void v2('POST', '/v2/me/recovery-codes', {}).then((out) => {
          if (out.status !== 201) return toast(out.body?.message ?? 'The codes could not be made.', 6000)
          const box = $('me-codes')
          box.textContent = out.body.codes.join('\n')
          box.hidden = false
          $('me-codes-note').textContent = 'Shown once. Copy them somewhere safe; each opens the account exactly once.'
        })
      } else if (el.dataset.editName !== undefined) {
        const displayName = prompt('Display name (up to 40 characters)', '')
        if (displayName === null) return
        void v2('PATCH', '/v2/me', { displayName }).then((out) => {
          if (out.status === 200) return refresh()
          toast(out.body?.message ?? 'That name was not accepted.', 6000)
        })
      } else if (el.dataset.password !== undefined) {
        const current = prompt('Your current password')
        if (current === null) return
        const next = prompt('The new one — at least 12 characters')
        if (next === null) return
        void v2('POST', '/v2/me/password', { current, next }).then((out) => {
          toast(out.status === 204 ? 'Password changed.' : (out.body?.message ?? 'That did not go through.'), 6000)
        })
      }
    })
  }

  /* ── seats on a team page (W2) ──────────────────────────────────────────
   *
   * The page is already rendered for whoever asked: signed out, unseated,
   * seated, or the owner's own view. These are only the VERBS — copy the ask
   * link, grant a seat, end one, and press the line's own entry. Nothing here
   * re-renders a state the server decided, so the two can never disagree.
   */
  const seatbar = $('seatbar')
  if (seatbar) {
    const team = seatbar.dataset.team ?? ''
    /** The line's own gate button. Buying and opening are its ceremony, unchanged. */
    const pressTheLine = () => {
      const open = $('btn-open')
      if (!open) return toast('This team is not on the relay — open it in Cookrew.')
      open.scrollIntoView({ block: 'center' })
      // A disabled entry swallows a click silently, and silence reads as a
      // broken button rather than as "nobody is serving this right now".
      if (open.disabled) return toast('Nobody is serving this team right now — the address stays valid.', 5000)
      open.click()
    }

    /**
     * COPY THE ASK LINK. navigator.clipboard is absent over plain http and on
     * an older browser, so the link is put on the page instead of being lost:
     * a person can always copy what they can see.
     */
    const copyAsk = async (link) => {
      try {
        await navigator.clipboard.writeText(link)
        toast('Link copied. Send it to the owner; it names you.')
      } catch {
        const shown = $('seat-ask-link')
        if (shown) {
          shown.hidden = false
          shown.textContent = link
          const range = document.createRange()
          range.selectNodeContents(shown)
          getSelection()?.removeAllRanges()
          getSelection()?.addRange(range)
        }
        toast('This browser would not take the clipboard — the link is on the page, ready to copy.', 6000)
      }
    }

    const seatCall = (method, path, body) =>
      v2(method, `/v2/teams/${team}${path}`, body).then((out) => {
        if (out.status === 201 || out.status === 204) return location.reload()
        toast(out.body?.message ?? 'That did not go through. Try again in a moment.', 6000)
      })

    seatbar.addEventListener('click', (event) => {
      const el = event.target.closest('[data-seat-ask],[data-seat-buy],[data-seat-open],[data-seat-grant],[data-seat-end]')
      if (!el) return
      event.preventDefault()
      if (el.dataset.seatAsk !== undefined) void copyAsk(el.dataset.seatAsk)
      else if (el.dataset.seatBuy !== undefined || el.dataset.seatOpen !== undefined) pressTheLine()
      else if (el.dataset.seatGrant !== undefined) {
        const username = ($('seat-username')?.value ?? '').trim().toLowerCase().replace(/^@/, '')
        if (!USERNAME.test(username)) return toast('A username is lowercase letters, digits and dashes.')
        void seatCall('POST', '/seats', { username })
      } else if (el.dataset.seatEnd !== undefined) {
        if (!confirm('This person stops opening the team at their next call. Their session ends when they close it. End the seat?')) return
        void seatCall('DELETE', `/seats/${encodeURIComponent(el.dataset.seatEnd)}`)
      }
    })
    $('seat-username')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      seatbar.querySelector('[data-seat-grant]')?.click()
    })
  }

  /** Who the header should name: a v2 session first, then the v1 key. */
  void v2('GET', '/v2/me').then((out) => {
    if (out.status !== 200 || !out.body?.username) return
    const button = $('signin')
    if (!button) return
    button.textContent = `@${out.body.username}`
    button.dataset.signin = 'me'
  })

  /* ── the crew builder (/start) ─────────────────────────────────────────── */
  const builder = $('crew-builder')
  if (builder) {
    const NAMES = ['Forge', 'Bench', 'Atlas', 'Magpie', 'Fresco', 'Velvet', 'Tinker', 'Sol']
    const render = () => {
      const harnesses = [...builder.querySelectorAll('input[name=h]:checked')].map((i) => i.value)
      const roles = ($('crew-roles')?.value ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean)
      const n = Math.max(harnesses.length, roles.length, 1)
      const q = (v) => `"${String(v).replace(/[\\"]/g, '\\$&')}"`
      const lines = []
      const names = []
      for (let i = 0; i < n; i++) {
        const name = NAMES[i % NAMES.length]
        names.push(name)
        const preset = harnesses[i % Math.max(harnesses.length, 1)] ?? 'Claude Code'
        const role = roles[i % Math.max(roles.length, 1)] ?? 'teammate'
        lines.push(`$ cookrew recruit ${q(name)} --preset ${q(preset)} --role ${q(role)}`)
      }
      for (let i = 1; i < names.length; i++) lines.push(`$ cookrew connect "${names[0]}" "${names[i]}"`)
      if ($('crew-orch')?.checked) lines.push(`$ cookrew orch "${names[0]}"`)
      $('crew-script').textContent = lines.join('\n')
      return lines.map((l) => l.replace(/^\$ /, '')).join('\n')
    }
    builder.addEventListener('input', render)
    $('crew-copy')?.addEventListener('click', () => navigator.clipboard.writeText(render()).then(() => toast('Commands copied. Paste them into a terminal with Cookrew running.')))
    render()
  }

  window.cookrewAccount = {
    token,
    handle: async () => (await loadAccount())?.handle ?? null,
    signIn: signInFlow,
    /** The v2 sheet — a username and a password. What the header opens. */
    account: openAccountSheet,
    toast,
    doorKey
  }
})()
