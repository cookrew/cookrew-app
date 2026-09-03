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

  window.cookrewAccount = { token, handle: async () => (await loadAccount())?.handle ?? null, signIn: signInFlow, toast }
})()
