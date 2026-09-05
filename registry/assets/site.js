/* cookrew.dev — the site's one script: account, stars, deep links, copy.
 *
 * ACCOUNT. A cookrew.dev account is a HANDLE with DEVICES, and this browser is
 * one device of it. The key never leaves the browser (a non-extractable
 * WebCrypto key in IndexedDB); signing in is the registry's own ceremony — the
 * same one the app performs with node:crypto — and it mints a short-lived
 * token. There is no password and nothing to reset.
 *
 * Three ways in, and they are three different situations rather than three
 * spellings of one:
 *
 *   ENROL    a brand-new handle, with this browser as its first device.
 *   LINK     an account you already hold, using a six-character code you read
 *            off the app or your phone. This browser becomes another device.
 *   PASSKEY  a platform authenticator that some device of the account added;
 *            the account is found through it, so nothing has to be typed.
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
  const api = async (path, body, bearer) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
      },
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
    // A browser signed in BY PASSKEY holds no key of its own, so every fresh
    // token is another authenticator ceremony. That is why the cache above
    // matters more here than anywhere else: without it, starring a team would
    // ask for Touch ID twice.
    const body = account.passkey
      ? { ...(await passkeyAssertion(account.handle)), scope, ...(aud ? { aud } : {}) }
      : await assertion(account, scope, aud)
    const out = await api('/v1/identity/assert', body)
    if (out.status !== 200 || !out.body?.token) throw new Error('sign-in was refused — this browser may have been revoked from the account')
    tokens.set(key, out.body.token)
    if (scope === 'download') setCookie(out.body.token)
    else sessionStorage.removeItem('cr_refreshed')
    return out.body.token
  }

  /* ── passkeys ──────────────────────────────────────────────────────────── */
  const hasPasskeys = () => typeof window.PublicKeyCredential === 'function'

  /** A real WebAuthn assertion, encoded the way the registry reads it. */
  async function passkeyAssertion(handle) {
    const issued = await api('/v1/identity/challenge')
    if (issued.status !== 200 || !issued.body?.challenge) throw new Error('the registry issued no challenge')
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: unb64u(issued.body.challenge),
        rpId: location.hostname,
        userVerification: 'preferred',
        timeout: 60_000
      }
    })
    if (!credential) throw new Error('no passkey was offered')
    return {
      ...(handle ? { handle } : {}),
      credential: {
        id: credential.id,
        rawId: b64u(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: b64u(credential.response.clientDataJSON),
          authenticatorData: b64u(credential.response.authenticatorData),
          signature: b64u(credential.response.signature),
          ...(credential.response.userHandle ? { userHandle: b64u(credential.response.userHandle) } : {})
        }
      }
    }
  }

  /** Sign in with a passkey: the account is discovered, never typed. */
  async function signInWithPasskey() {
    const out = await api('/v1/identity/assert', { ...(await passkeyAssertion()), scope: 'download' })
    if (out.status !== 200 || !out.body?.token) throw new Error('that passkey is not enrolled here')
    const claims = claimsOf(out.body.token)
    if (!claims?.sub) throw new Error('the registry answered with a token it will not explain')
    await saveAccount({ handle: claims.sub, passkey: true })
    tokens.set('download|', out.body.token)
    setCookie(out.body.token)
    return claims.sub
  }

  /** Add a platform passkey to the account this browser already holds. */
  async function addPasskey(handle) {
    const bearer = await token('account')
    if (!bearer) throw new Error('sign in first')
    const opts = await api(`/v1/accounts/@${handle}/passkey/options`, {}, bearer)
    if (opts.status !== 200 || !opts.body?.challenge) throw new Error('the registry refused to start the ceremony')
    const created = await navigator.credentials.create({
      publicKey: {
        ...opts.body,
        challenge: unb64u(opts.body.challenge),
        user: { ...opts.body.user, id: unb64u(opts.body.user.id) }
      }
    })
    if (!created) throw new Error('no passkey was created')
    const res = await api(
      `/v1/accounts/@${handle}/passkey`,
      {
        name: `${location.hostname} passkey`,
        credential: {
          id: created.id,
          rawId: b64u(created.rawId),
          response: {
            clientDataJSON: b64u(created.response.clientDataJSON),
            attestationObject: b64u(created.response.attestationObject)
          }
        }
      },
      bearer
    )
    if (res.status !== 201) throw new Error(`the registry refused the passkey (${res.status})`)
    return res.body
  }

  const cleanHandle = (handle) => {
    const clean = String(handle ?? '').trim().toLowerCase().replace(/^@/, '')
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(clean)) {
      throw new Error('a handle is 1–32 lowercase letters, digits or dashes')
    }
    return clean
  }

  /** This browser as a DEVICE: a fresh key, a UUID it chooses, a readable name. */
  async function newDevice() {
    const key = await mintKey()
    const jwk = await crypto.subtle.exportKey('jwk', key.pair.publicKey)
    const publicHalf =
      jwk.kty === 'OKP' ? { kty: jwk.kty, crv: jwk.crv, x: jwk.x } : { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
    return {
      key,
      device: {
        id: crypto.randomUUID(),
        jwk: publicHalf,
        kind: 'browser',
        name: `${location.hostname} browser`
      }
    }
  }

  /** A brand-new handle, with this browser as its first device. */
  async function enrol(handle) {
    const clean = cleanHandle(handle)
    const { key, device } = await newDevice()
    const res = await api('/v1/accounts', { handle: clean, device })
    if (res.status === 409) throw new Error(`@${clean} is already taken — link this browser with a code from a device you hold`)
    if (res.status !== 201) throw new Error(`the registry refused the enrolment (${res.status})`)
    await saveAccount({ handle: clean, deviceId: device.id, alg: key.alg, pair: key.pair })
    return clean
  }

  /**
   * Join an account this browser has never seen, with a code from one that
   * holds it. The code is the authority — this browser has no key the account
   * knows yet, which is the entire reason the route takes no token.
   */
  async function linkBrowser(handle, code) {
    const clean = cleanHandle(handle)
    const typed = String(code ?? '').trim().toUpperCase()
    if (!/^[A-Z2-9]{6}$/.test(typed)) throw new Error('a link code is six characters from another device')
    const { key, device } = await newDevice()
    const res = await api(`/v1/accounts/@${clean}/link`, { code: typed, device })
    if (res.status === 410) throw new Error('that code has expired — ask for another, they last two minutes')
    if (res.status !== 201) throw new Error('that code was not recognised for this handle')
    await saveAccount({ handle: clean, deviceId: device.id, alg: key.alg, pair: key.pair })
    return clean
  }

  /* ── the sign-in sheet ─────────────────────────────────────────────────── */
  const FIELD =
    'font:14px var(--font-mono);padding:8px 10px;border:2px solid var(--line);background:var(--cream-hi);color:var(--ink);min-width:170px'

  /**
   * The sheet is BUILT, never assembled from a string with handlers in it: the
   * site's CSP forbids inline script, and a dialog whose buttons only work
   * because of an onclick attribute is a sheet that silently stops working the
   * day the policy is tightened. Every button is a form value the close handler
   * reads.
   */
  function sheet() {
    let dialog = $('signin-sheet')
    if (dialog) return dialog
    dialog = document.createElement('dialog')
    dialog.id = 'signin-sheet'
    dialog.className = 'card'
    const title = document.createElement('h3')
    title.style.marginTop = '0'
    title.textContent = 'Your cookrew.dev account'
    const lede = document.createElement('p')
    lede.className = 'meta'
    lede.id = 'signin-lede'
    const form = document.createElement('form')
    form.method = 'dialog'
    form.id = 'signin-form'
    const note = document.createElement('p')
    note.className = 'meta'
    note.id = 'signin-note'
    note.style.marginTop = '10px'
    dialog.append(title, lede, form, note)
    document.body.appendChild(dialog)
    return dialog
  }

  const button = (value, label, primary) => {
    const el = document.createElement('button')
    el.className = primary ? 'btn primary' : 'btn'
    el.value = value
    el.textContent = label
    return el
  }

  const field = (id, placeholder, extra) => {
    const el = document.createElement('input')
    el.id = id
    el.placeholder = placeholder
    el.spellcheck = false
    el.setAttribute('style', FIELD)
    if (extra) Object.assign(el, extra)
    return el
  }

  const row = (...children) => {
    const el = document.createElement('div')
    el.className = 'row'
    el.append(...children)
    return el
  }

  /** The sheet for a browser that already holds an account. */
  function signedInSheet(dialog, account) {
    const form = dialog.querySelector('#signin-form')
    form.replaceChildren()
    const who = document.createElement('span')
    who.className = 'chip amber'
    who.textContent = `@${account.handle}`
    const buttons = [who]
    // Adding a passkey is what makes losing every device survivable, so it is
    // offered wherever the browser can actually do it.
    if (hasPasskeys() && !account.passkey) buttons.push(button('passkey', 'Add a passkey'))
    buttons.push(button('out', "Forget this browser's key"), button('cancel', 'Close'))
    form.append(row(...buttons))
    dialog.querySelector('#signin-lede').textContent =
      'This browser is one device of your account. Other devices can be added, and any of them can drop this one.'
    dialog.querySelector('#signin-note').textContent =
      'Stars and the line use this account. Forgetting the key here removes nothing from the account — revoke this device from another one.'
  }

  /** The sheet for a browser with no account: enrol, link, or a passkey. */
  function signedOutSheet(dialog) {
    const form = dialog.querySelector('#signin-form')
    form.replaceChildren()
    form.append(
      row(field('signin-handle', 'handle', { autocomplete: 'username' }), button('enrol', 'Enrol a new handle', true)),
      row(field('signin-code', 'link code', { maxLength: 6, autocomplete: 'one-time-code' }), button('link', 'Link this browser'))
    )
    if (hasPasskeys()) form.append(row(button('passkey', 'Sign in with a passkey')))
    form.append(row(button('cancel', 'Cancel')))
    dialog.querySelector('#signin-lede').textContent =
      'A handle with devices. No password: this browser holds a key, and a device you already have vouches for it.'
    dialog.querySelector('#signin-note').textContent =
      'Already have a handle? Ask a device that holds it for a six-character code, type the handle and the code, and press Link.'
  }

  async function signedInAction(action, account) {
    if (action === 'out') {
      await forgetAccount()
      tokens.clear()
      document.cookie = 'cr_account=; Path=/; Max-Age=0'
      location.reload()
      return
    }
    if (action === 'passkey') {
      await addPasskey(account.handle)
      toast('Passkey added. It can sign in for this account on any device that syncs it.')
    }
  }

  async function signedOutAction(action, dialog) {
    const handle = dialog.querySelector('#signin-handle')?.value ?? ''
    const code = dialog.querySelector('#signin-code')?.value ?? ''
    if (action === 'passkey') {
      const who = await signInWithPasskey()
      toast(`Signed in as @${who}.`)
    } else if (action === 'link') {
      const who = await linkBrowser(handle, code)
      await token('download')
      toast(`This browser is now a device of @${who}.`)
    } else {
      const who = await enrol(handle)
      await token('download')
      toast(`Enrolled @${who}. Signed in.`)
    }
    setTimeout(() => location.reload(), 600)
  }

  async function signInFlow() {
    const account = await loadAccount()
    const dialog = sheet()
    if (account) signedInSheet(dialog, account)
    else signedOutSheet(dialog)
    dialog.showModal()
    if (!account) dialog.querySelector('#signin-handle')?.focus()
    dialog.onclose = async () => {
      const action = dialog.returnValue
      if (action === 'cancel' || action === '') return
      try {
        if (account) await signedInAction(action, account)
        else await signedOutAction(action, dialog)
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
      void signInFlow()
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
    toast,
    doorKey,
    // Additive: the shape above is what line.js binds to and does not move.
    device: async () => (await loadAccount())?.deviceId ?? null,
    addPasskey,
    linkBrowser
  }
})()
